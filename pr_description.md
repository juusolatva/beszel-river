🎯 **What:** The testing gap addressed
This PR addresses the testing gap in `parseFrame` function in `frontend/src/source/stream.ts`. It adds comprehensive tests for error states, JSON parsing edge cases, and channel/filament clamping to ensure safety in rendering streams.

📊 **Coverage:** What scenarios are now tested
- Tests non-JSON string inputs, ensuring `null` is returned
- Tests invalid schemas: non-object structures, wrong versions (`v`), missing time (`t`), and missing/malformed `streams` array
- Tests robust handling of valid frames, including value clamping correctly processing invalid array elements within stream configurations
- Validates the `filaments` logic ensuring correct array length processing and clamping

✨ **Result:** The improvement in test coverage
We now have a dedicated test file `frontend/src/source/stream.test.ts` providing near 100% coverage on stream parsing behaviors. This solidifies our confidence in rendering real-time or mocked events properly and dropping bad payloads without breaking the app.
