import { extname, isAbsolute, resolve } from "node:path";

export type ImageExt = ".jpg" | ".jpeg" | ".png" | ".webp" | ".gif";

/** Ensure output path has the format extension the API actually returns. */
export function ensureImageExtension(
  path: string,
  defaultExt: ImageExt = ".jpg",
  forceExtension = false,
): string {
  const ext = extname(path).toLowerCase();
  const supported = ext === ".jpg" || ext === ".jpeg" || ext === ".png" || ext === ".webp" || ext === ".gif";
  if (!supported) return `${path}${defaultExt}`;
  if (!forceExtension) return path;
  const jpegMatch = (ext === ".jpg" || ext === ".jpeg") && defaultExt === ".jpg";
  if (ext === defaultExt || jpegMatch) return path;
  return `${path.slice(0, -ext.length)}${defaultExt}`;
}

export function resolveOutputPath(
  outputPath: string,
  cwd: string,
  defaultExt: ImageExt = ".jpg",
  forceExtension = false,
): string {
  const cleaned = outputPath.trim();
  if (!cleaned) throw new Error("output_path is required");
  const withExt = ensureImageExtension(cleaned, defaultExt, forceExtension);
  return isAbsolute(withExt) ? withExt : resolve(cwd, withExt);
}

/**
 * Expand one output_path into `n` concrete paths.
 * - n === 1: path as-is
 * - n > 1: replace `{i}` with 1-based index, else insert `-${i}` before extension
 */
export function expandOutputPaths(
  outputPath: string,
  n: number,
  cwd: string,
  defaultExt: ImageExt = ".jpg",
  forceExtension = false,
): string[] {
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`n must be an integer >= 1, got ${n}`);
  }
  const base = resolveOutputPath(outputPath, cwd, defaultExt, forceExtension);
  if (n === 1) return [base];

  const ext = extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;

  return Array.from({ length: n }, (_, idx) => {
    const i = idx + 1;
    if (base.includes("{i}")) {
      return base.replaceAll("{i}", String(i));
    }
    return `${stem}-${i}${ext || defaultExt}`;
  });
}

export function clampN(n: unknown, max: number): number {
  if (n === undefined || n === null) return 1;
  const value = typeof n === "number" ? n : Number(n);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`n must be an integer between 1 and ${max}`);
  }
  if (value > max) {
    throw new Error(`n must be <= ${max}`);
  }
  return value;
}
