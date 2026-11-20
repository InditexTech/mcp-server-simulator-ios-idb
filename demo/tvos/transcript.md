# tvOS demo transcript

Every line is a natural-language instruction sent to the MCP `process-instruction` tool.

- `create session with mcp-integration-<id>` → **success** — `"session_<id>"`
- `install app <tmp>/FixtureApp.app` → **success** — `{"bundleId":"com.inditex.mcp.fixture.demo","name":"FixtureApp","installedPath":"<tmp>/FixtureApp.app"}`
- `launch app com.inditex.mcp.fixture.demo` → **success** — `{"bundleId":"com.inditex.mcp.fixture.demo"}`
- `record video <out>/tvos-demo.mp4` → **success** — `"recording_<id>"`
- `press remote down` → **success** — `{"action":"down"}`
- `press remote select` → **success** — `{"action":"select"}`
- `pulsar mando arriba` → **success** — `{"action":"up"}`
- `press remote select` → **success** — `{"action":"select"}`
- `press device button PLAY_PAUSE` → **success** — `{"button":"PLAY_PAUSE"}`

## Guardrails (honest errors on a device without a touchscreen)

- `tap at 100, 200` → **error** — `Touch input (tap) is not supported on tvOS simulators (no touchscreen). Use Siri Remote navigation ("press remote up/down/left/right/select/menu") or accessibility element activation ("tap element ...") instead.`
- `swipe from 100, 100 to 300, 300` → **error** — `Touch input (swipe) is not supported on tvOS simulators (no touchscreen). Use Siri Remote navigation ("press remote up/down/left/right/select/menu") or accessibility element activation ("tap element ...") instead.`
- `set orientation to landscape left` → **error** — `Device orientation control is not supported on tvOS simulators.`
- `stop recording` → **success** — `{"sessionId":"session_<id>"}`
- `press remote menu` → **success** — `{"action":"menu"}`
