// parsing.service.ts — request parsing + zod validation as Results (from
// soothing-booking's src/services/web/parsing.service.ts, with its
// failure-to-errors fallthrough and ValidationResult alias fixed). API
// routes call parseAndValidateAPIRequest; failures map to responses with
// failureResponse (responses.service.ts). Imports `zod`, not `astro/zod`:
// this module is also compiled by the plain-tsc server build (and unit-
// tested there).
import type { z, ZodType } from "zod";
import type { ResultFailure, ResultSuccess } from "../../types/result";

export type ParseSuccess<DataType extends object> = ResultSuccess<"parse_request", DataType>;
export type ParseErrorCode = "unsupported_content_type" | "invalid_json" | "invalid_form_data";
export type ParseFailure<DataType extends object> = ResultFailure<"parse_request", DataType, ParseErrorCode>;
export type ParseResult<DataType extends object> = ParseSuccess<DataType> | ParseFailure<DataType>;

export type ValidationSuccess<DataType extends object> = ResultSuccess<"validation", DataType>;
export type ValidationErrorCode = "validation_failure";
export type ValidationFailureData = {
  issues: Record<string, string>;
};
export type ValidationFailure<DataType extends object> = ResultFailure<"validation", DataType, ValidationErrorCode> &
  ValidationFailureData;
export type ValidationResult<DataType extends object> = ValidationSuccess<DataType> | ValidationFailure<DataType>;

export type FileUploadSuccess = ResultSuccess<"file_upload", ParsedUpload>;
export type FileUploadErrorCode = "unsupported_file_type" | "file_too_large" | "no_file_provided";
export type FileUploadFailure = ResultFailure<"file_upload", ParsedUpload, FileUploadErrorCode>;
export type FileUploadResult = FileUploadSuccess | FileUploadFailure;

/** Basic Request Parsers **/
export async function parseAPIRequest<DataType extends object>(request: Request) {
  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    return parseJSON<DataType>(request);
  } else if (contentType.includes("application/x-www-form-urlencoded")) {
    return parseForm<DataType>(request);
  } else {
    return {
      ok: false,
      resultType: "parse_request",
      errorCode: "unsupported_content_type",
    } satisfies ParseFailure<DataType>;
  }
}
export type ParseAPIRequestResult<DataType extends object> = Awaited<ReturnType<typeof parseAPIRequest<DataType>>>;

export async function parseFormPost<DataType extends object>(request: Request) {
  const contentType = request.headers.get("content-type") ?? "";
  const is_form_post = contentType.includes("application/x-www-form-urlencoded") && request.method === "POST";

  if (!is_form_post) {
    return {
      ok: false,
      resultType: "parse_request",
      errorCode: "unsupported_content_type",
    } satisfies ParseFailure<DataType>;
  }

  return parseForm<DataType>(request);
}
export type ParseFormPostResult<DataType extends object> = Awaited<ReturnType<typeof parseFormPost<DataType>>>;

export async function parseJSON<DataType extends object>(request: Request) {
  try {
    return {
      ok: true,
      resultType: "parse_request",
      data: (await request.json()) as DataType,
    } satisfies ParseSuccess<DataType>;
  } catch {
    // Also the oversized-body path: the adapter's bodySizeLimit aborts the
    // stream mid-read, which surfaces here as a failed parse.
    return {
      ok: false,
      resultType: "parse_request",
      errorCode: "invalid_json",
    } satisfies ParseFailure<DataType>;
  }
}

export async function parseForm<DataType extends object>(request: Request) {
  try {
    const formData = await request.formData();
    return {
      ok: true,
      resultType: "parse_request",
      data: Object.fromEntries(formData.entries()) as unknown as DataType,
    } satisfies ParseSuccess<DataType>;
  } catch {
    return {
      ok: false,
      resultType: "parse_request",
      errorCode: "invalid_form_data",
    } satisfies ParseFailure<DataType>;
  }
}

/** Request parsers with Zod validation */

export async function parseAndValidateFormPost<DataType extends object>(request: Request, schema: ZodType<DataType>) {
  const parseResult = await parseFormPost<DataType>(request);
  if (!parseResult.ok) {
    return parseResult;
  }

  return parseZod<DataType>(parseResult.data, schema);
}
export type ParseAndValidateFormPostResult<DataType extends object> = Awaited<
  ReturnType<typeof parseAndValidateFormPost<DataType>>
>;
export type ParseAndValidateFormPostFailure<DataType extends object> = Extract<
  ParseAndValidateFormPostResult<DataType>,
  { ok: false }
>;

export async function parseAndValidateAPIRequest<DataType extends object>(
  request: Request,
  schema: z.ZodType<DataType>,
) {
  const parseResult = await parseAPIRequest<DataType>(request);
  if (!parseResult.ok) {
    return parseResult;
  }

  return parseZod<DataType>(parseResult.data, schema);
}
export type ParseAndValidateAPIRequestResult<DataType extends object> = Awaited<
  ReturnType<typeof parseAndValidateAPIRequest<DataType>>
>;

/** Validate a value against a schema: per-field issues (first issue per
 *  field, keyed by its dotted path; "" for the root) on failure. */
export function parseZod<DataType extends object>(data: unknown, schema: z.ZodType<DataType>) {
  const zodSafeParseResult = schema.safeParse(data);

  if (!zodSafeParseResult.success) {
    const issues: Record<string, string> = {};
    for (const issue of zodSafeParseResult.error.issues) {
      const field = issue.path.map(String).join(".");
      if (!issues[field]) {
        issues[field] = issue.message;
      }
    }
    return {
      ok: false,
      resultType: "validation",
      errorCode: "validation_failure",
      errorMessage: "Failed validation",
      issues,
    } satisfies ValidationFailure<DataType>;
  }

  return {
    ok: true,
    resultType: "validation",
    data: zodSafeParseResult.data,
  } satisfies ValidationSuccess<DataType>;
}

/** File upload parser */

export interface FileUploadOptions {
  fieldName?: string;
  maxSize: number;
  allowedMimeTypes: readonly string[];
}

export interface ParsedUpload {
  file: File;
  buffer: Buffer;
}

export async function parseFileUpload(request: Request, options: FileUploadOptions) {
  const contentType = request.headers.get("content-type") ?? "";
  const is_multipart = contentType.includes("multipart/form-data");

  if (!is_multipart) {
    return {
      ok: false,
      resultType: "file_upload",
      errorCode: "no_file_provided",
    } satisfies FileUploadFailure;
  }

  const fieldName = options.fieldName ?? "file";
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return {
      ok: false,
      resultType: "file_upload",
      errorCode: "no_file_provided",
      errorMessage: "Invalid multipart body",
    } satisfies FileUploadFailure;
  }
  const file = formData.get(fieldName);

  if (!(file instanceof File) || file.size === 0) {
    return {
      ok: false,
      resultType: "file_upload",
      errorCode: "no_file_provided",
    } satisfies FileUploadFailure;
  }

  if (file.size > options.maxSize) {
    return {
      ok: false,
      resultType: "file_upload",
      errorCode: "file_too_large",
      errorMessage: `File too large, max size is ${Math.floor(options.maxSize / 1024)}KB`,
    } satisfies FileUploadFailure;
  }

  const is_allowed_type = options.allowedMimeTypes.includes(file.type);
  if (!is_allowed_type) {
    return {
      ok: false,
      resultType: "file_upload",
      errorCode: "unsupported_file_type",
      errorMessage: `Unsupported file type, supported types are ${options.allowedMimeTypes.join(", ")}`,
    } satisfies FileUploadFailure;
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  return {
    ok: true,
    resultType: "file_upload",
    data: { file, buffer },
  } satisfies FileUploadSuccess;
}

/** A form post's failure as what a page renders: a form-level message
 *  and per-field issues. Exhaustive over the codes a form post can fail
 *  with — a new code is a type error here. */
export function parseAndValidateFailureToErrors<DataType extends object>(
  parseAndValidateFailure: ParseAndValidateFormPostFailure<DataType>,
) {
  const noIssues: Record<string, string> = {};

  switch (parseAndValidateFailure.errorCode) {
    case "validation_failure":
      return { errorMessage: "", issues: parseAndValidateFailure.issues };
    case "invalid_form_data":
      return {
        errorMessage: "Sorry, there was an error on our side. Please try again (error: 'invalid form data').",
        issues: noIssues,
      };
    case "unsupported_content_type":
      return {
        errorMessage: "Sorry, there was an error on our side. Please try again (error: 'unsupported content type').",
        issues: noIssues,
      };
    default:
      return parseAndValidateFailure satisfies never;
  }
}
