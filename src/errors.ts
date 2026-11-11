import {
  AbortError,
  ApiError,
  BuildFileError,
  BuildProcessingError,
  StillProcessingError,
  TransferError,
} from "appdropper/api";
import { redact } from "./log.js";

/**
 * Every failure a tool can report, reduced to what a model needs to explain it
 * and decide what to do next: a stable code, the server's own wording, and —
 * where there is one — the single next step.
 */
export interface ToolFailure {
  code: FailureCode;
  message: string;
  /** What the user should do about it, if anything. */
  hint?: string;
  /** Present on plan-limit errors: where to upgrade. */
  upgrade_url?: string;
  /** The plan that lifts the limit ("pro" or "studio"), when the API said so. */
  upgrade_to?: string;
  /** True when trying the same call again later can succeed. */
  retryable: boolean;
  /** The upload this concerns, so the build can still be found later. */
  upload_id?: string;
  /** HTTP status from the App Dropper API, when the API produced the error. */
  http_status?: number;
}

export type FailureCode =
  | "not_authenticated"
  | "unauthorized"
  | "plan_limit"
  | "forbidden"
  | "not_found"
  | "rate_limited"
  | "invalid_request"
  | "server_error"
  | "network_error"
  | "upload_interrupted"
  | "processing_timeout"
  | "invalid_build"
  | "file_not_found"
  | "not_a_file"
  | "unsupported_file_type"
  | "empty_file"
  | "invalid_path"
  | "invalid_directory"
  | "cancelled";

export const LOGIN_HINT =
  "Run `npx appdropper login` once in a terminal (it opens a browser to approve this machine), then try again. Or set APPDROPPER_TOKEN for this MCP server.";

/** Thrown when there is no credential at all — before any request is made. */
export class NotAuthenticatedError extends Error {
  constructor() {
    super("App Dropper isn't signed in on this machine.");
    this.name = "NotAuthenticatedError";
  }
}

/** A local precondition failed — a bad path or directory argument. */
export class LocalInputError extends Error {
  constructor(
    readonly code: "invalid_path" | "invalid_directory",
    message: string,
    readonly hint?: string
  ) {
    super(message);
    this.name = "LocalInputError";
  }
}

const URL_PATTERN = /https?:\/\/[^\s)]+/;

/** The upgrade link App Dropper puts at the end of every plan-limit message. */
function upgradeUrl(message: string): string | undefined {
  if (!/upgrade/i.test(message)) return undefined;
  return message.match(URL_PATTERN)?.[0]?.replace(/[.,;]+$/, "");
}

/** The API's structured `upgrade` block, carried by appdropper 1.4.0 and later. */
interface UpgradeBlock {
  limit?: string;
  upgrade_to?: string | null;
  upgrade_url?: string;
}

/**
 * Where to upgrade, preferring the API's structured block over parsing the
 * message (older appdropper versions and servers only have the message).
 */
function upgradeFor(
  err: unknown,
  message: string
): { upgrade_url?: string; upgrade_to?: string; limit?: string } {
  const block = (err as { upgrade?: UpgradeBlock }).upgrade;
  if (block?.upgrade_url) {
    return {
      upgrade_url: block.upgrade_url,
      ...(block.upgrade_to ? { upgrade_to: block.upgrade_to } : {}),
      ...(block.limit ? { limit: block.limit } : {}),
    };
  }
  const url = upgradeUrl(message);
  return url ? { upgrade_url: url } : {};
}

const PLAN_LIMIT_HINT =
  "This is a plan limit, so retrying won't help. Tell the user, and share the upgrade link.";
const TOP_PLAN_HINT =
  "This is the highest plan's limit, so retrying won't help. Tell the user they can contact support to raise it.";

/** The right next step for a plan limit: upgrade, or (on Studio) support. */
function planHint(url: string | undefined): string {
  return url?.startsWith("mailto:") ? TOP_PLAN_HINT : PLAN_LIMIT_HINT;
}

const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EPIPE",
  "ENETUNREACH",
  "EHOSTUNREACH",
]);

export function toFailure(err: unknown): ToolFailure {
  const failure = classify(err);
  // Belt and braces: no message leaves this server carrying a token, even if
  // some upstream error happened to echo one.
  return {
    ...failure,
    message: redact(failure.message),
    ...(failure.hint ? { hint: redact(failure.hint) } : {}),
  };
}

function classify(err: unknown): ToolFailure {
  if (err instanceof NotAuthenticatedError) {
    return { code: "not_authenticated", message: err.message, hint: LOGIN_HINT, retryable: false };
  }
  if (err instanceof LocalInputError) {
    return { code: err.code, message: err.message, hint: err.hint, retryable: false };
  }
  if (err instanceof AbortError || (err as Error)?.name === "AbortError") {
    return { code: "cancelled", message: "The request was cancelled.", retryable: true };
  }
  if (err instanceof BuildFileError) {
    const code = (
      {
        not_found: "file_not_found",
        not_a_file: "not_a_file",
        unsupported_type: "unsupported_file_type",
        empty: "empty_file",
      } as const
    )[err.code];
    return {
      code,
      message: err.message,
      hint:
        code === "file_not_found" || code === "not_a_file"
          ? "Check the path, or call find_builds to locate .apk and .ipa files in the project."
          : code === "unsupported_file_type"
            ? "Only .apk (Android) and .ipa (iOS) files can be uploaded. Build or export one first."
            : undefined,
      retryable: false,
    };
  }
  if (err instanceof BuildProcessingError) {
    const plan = err.code === "upgrade_required";
    const upgrade = plan ? upgradeFor(err, err.message) : {};
    return {
      code: plan ? "plan_limit" : "invalid_build",
      message: err.message,
      upgrade_url: upgrade.upgrade_url,
      ...(upgrade.upgrade_to ? { upgrade_to: upgrade.upgrade_to } : {}),
      hint: plan
        ? planHint(upgrade.upgrade_url)
        : "App Dropper received the file but couldn't read it as an app. Check it is a complete, signed .apk or an exported .ipa.",
      upload_id: err.uploadId,
      retryable: false,
    };
  }
  if (err instanceof StillProcessingError) {
    return {
      code: "processing_timeout",
      message:
        "The build uploaded, but App Dropper is still processing it. Nothing was lost — it will appear in the app's build list shortly.",
      hint: "Call list_builds in a minute to get the install link.",
      upload_id: err.uploadId,
      retryable: false,
    };
  }
  if (err instanceof TransferError) {
    return {
      code: "upload_interrupted",
      message: err.message,
      hint: "The connection to storage dropped and couldn't be resumed. Try the upload again.",
      upload_id: err.uploadId,
      retryable: true,
    };
  }
  if (err instanceof ApiError) return fromApiError(err);

  const code = (err as NodeJS.ErrnoException)?.code;
  const message = err instanceof Error ? err.message : String(err);
  if ((code && NETWORK_CODES.has(code)) || /timed out|socket hang up/i.test(message)) {
    return {
      code: "network_error",
      message: `Couldn't reach App Dropper: ${message}`,
      hint: "Check the network connection and try again.",
      retryable: true,
    };
  }
  return { code: "server_error", message, retryable: false };
}

function fromApiError(err: ApiError): ToolFailure {
  const base = { message: err.message, http_status: err.status };
  const upgrade = upgradeFor(err, err.message);
  const plan = upgrade.upgrade_url;
  const planFields = {
    ...(plan ? { upgrade_url: plan } : {}),
    ...(upgrade.upgrade_to ? { upgrade_to: upgrade.upgrade_to } : {}),
  };
  switch (err.status) {
    case 401:
      return {
        ...base,
        code: "unauthorized",
        hint: `The App Dropper token was rejected (revoked, expired or incomplete). ${LOGIN_HINT}`,
        retryable: false,
      };
    case 402:
      return { ...base, code: "plan_limit", ...planFields, hint: planHint(plan), retryable: false };
    case 403:
      return {
        ...base,
        code: "forbidden",
        hint: "Call list_apps to see which apps this token can reach. Token access is changed at https://appdropper.io/dashboard/tokens.",
        retryable: false,
      };
    case 404:
      return { ...base, code: "not_found", retryable: false };
    case 429:
      // Servers before the fix sent a full storage quota as 429. Waiting never
      // frees space, so don't tell the model to retry it.
      if (plan && !upgrade.limit && /storage/i.test(err.message)) {
        return { ...base, code: "plan_limit", ...planFields, hint: planHint(plan), retryable: false };
      }
      return {
        ...base,
        code: "rate_limited",
        // The hourly upload cap is a 429 too (waiting does clear it), and
        // carries an upgrade link.
        ...planFields,
        hint: "Wait for the time given in the message, then try again.",
        retryable: true,
      };
    case 400:
    case 413:
      return { ...base, code: "invalid_request", retryable: false };
    default:
      return err.status >= 500
        ? {
            ...base,
            code: "server_error",
            hint: "App Dropper had a temporary problem. Try again shortly; https://appdropper.io/status shows live status.",
            retryable: true,
          }
        : { ...base, code: "invalid_request", retryable: false };
  }
}

/** The text a model reads for a failed call: what happened, then what to do. */
export function failureText(prefix: string, failure: ToolFailure): string {
  return [
    `${prefix}: ${failure.message}`,
    failure.upgrade_url
      ? failure.upgrade_url.startsWith("mailto:")
        ? `Contact: ${failure.upgrade_url.slice("mailto:".length)}`
        : failure.upgrade_to
        ? `Upgrade to ${failure.upgrade_to.charAt(0).toUpperCase()}${failure.upgrade_to.slice(1)}: ${failure.upgrade_url}`
        : `Upgrade: ${failure.upgrade_url}`
      : "",
    failure.hint ?? "",
    failure.upload_id ? `Upload ID: ${failure.upload_id}` : "",
    `(error code: ${failure.code}${failure.http_status ? `, HTTP ${failure.http_status}` : ""}${
      failure.retryable ? ", retryable" : ""
    })`,
  ]
    .filter(Boolean)
    .join("\n");
}
