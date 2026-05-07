import { spawnSync } from "node:child_process";
import path from "node:path";

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

function main(argv) {
  const [entryScriptRaw, ...rest] = argv;
  const entryScript = String(entryScriptRaw || "").trim();
  if (entryScript === "") {
    fail("Missing target CLI script path.");
    return;
  }

  const sortingId = String(rest[0] || "").trim();
  if (sortingId === "" || sortingId.startsWith("--")) {
    const scriptName = path.basename(entryScript);
    fail(
      `Missing required sorting id. Usage: npm run <script> -- <sorting-id> [args...]\n` +
        `Example: npm run test -- <sorting-id>\n` +
        `Target CLI: ${scriptName}`
    );
    return;
  }

  const forwardedArgs = rest.slice(1);
  for (let i = 0; i < forwardedArgs.length; i += 1) {
    const token = String(forwardedArgs[i] || "").trim();
    if (token === "--sorting" || token.startsWith("--sorting=")) {
      const scriptName = path.basename(entryScript);
      fail(
        `Do not pass --sorting in forwarded args.\n` +
          `Use only positional sorting id: npm run <script> -- <sorting-id> [args...]\n` +
          `Target CLI: ${scriptName}`
      );
      return;
    }
  }

  const child = spawnSync(
    process.execPath,
    [entryScript, "--sorting", sortingId, ...forwardedArgs],
    {
      stdio: "inherit",
      cwd: process.cwd(),
      env: process.env,
    }
  );

  if (child.error) {
    fail(child.error.message || String(child.error));
    return;
  }

  process.exitCode = typeof child.status === "number" ? child.status : 1;
}

main(process.argv.slice(2));
