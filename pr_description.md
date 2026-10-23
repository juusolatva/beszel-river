Title: 🧹 [code health improvement] Refactor console.log to process.stdout.write

🎯 **What:** The code health issue addressed
Refactored the synchronous `console.log` and `console.error` calls in `bridge/src/log.ts` to use `process.stdout.write` and `process.stderr.write`.

💡 **Why:** How this improves maintainability
`console.log` is synchronous and can block the event loop, which is detrimental to high-performance Node.js applications. `process.stdout.write` is better suited for robust logging in a server environment.

✅ **Verification:** How you confirmed the change is safe
Ran `npm run typecheck` and `npm test` to ensure no functionality is broken and all tests pass.

✨ **Result:** The improvement achieved
A more robust logging setup that avoids potential event loop blocking caused by synchronous console methods.
