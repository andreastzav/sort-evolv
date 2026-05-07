import path from "node:path";
import {
  parseSortingIdFromCliArgs,
  resolveFallbackSortingProfile,
  resolveSortingProfile,
} from "./sorting_profile_core.js";
export { toPositiveInt } from "./numeric_utils_core.js";

export function stripGlobalSortingArgs(argv) {
  const source = Array.isArray(argv) ? argv : [];
  const filtered = [];

  for (let i = 0; i < source.length; i += 1) {
    const token = String(source[i] || "");

    if (token === "--sorting") {
      const value = String(source[i + 1] || "").trim();
      if (value === "" || value.startsWith("--")) {
        throw new Error("--sorting requires a value.");
      }
      i += 1;
      continue;
    }

    if (token.startsWith("--sorting=")) {
      const value = token.slice("--sorting=".length).trim();
      if (value === "") {
        throw new Error("--sorting requires a value.");
      }
      continue;
    }

    filtered.push(token);
  }

  return filtered;
}

export function normalizeBaseFileName(value, optionName = "--base-file") {
  const text = String(value || "").trim();
  if (text === "") {
    throw new Error(`${optionName} requires a value.`);
  }

  const baseName = path.basename(text);
  if (baseName !== text) {
    throw new Error(`${optionName} must reference a .js file in the project root.`);
  }

  if (!baseName.toLowerCase().endsWith(".js")) {
    throw new Error(`${optionName} must end with .js`);
  }

  return baseName;
}

export function parseCsvList(value) {
  return String(value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

export function resolveHelpSortingProfile(argv = []) {
  try {
    const sortingId = parseSortingIdFromCliArgs(argv);
    if (sortingId !== "") {
      return resolveSortingProfile({ sortingId });
    }
  } catch {
    // Ignore malformed --sorting during help rendering.
  }

  return resolveFallbackSortingProfile();
}
