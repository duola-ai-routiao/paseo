# Paseo Hub

Paseo Hub is an opt-in control-plane connector for a local Paseo daemon. The
daemon remains the only owner of Codex, Claude, or Cursor provider sessions;
Ginit only enrolls the device and routes control/event frames, while Multica
owns task authorization and execution-target bindings.

After the user is logged into Ginit and has a Hub-capable Paseo CLI, `ginit
paseo attach` creates a ten-minute, single-use enrollment, redeems it with the
local daemon's Ed25519 public key, and writes the resulting Hub URL and bearer
token into Paseo's private config. The running daemon polls config and connects
without restarting provider sessions.

The bearer token is stored only as a hash by Ginit. The private Ed25519 key is
stored in `hub-device-keypair.json` with mode `0600`; it is separate from the
Relay encryption keypair. Hub handshake signatures cover
`protocolVersion:deviceId:daemonId:nonce`.

Paseo owns provider session state, Ginit owns enrollment and connection
fencing, and Multica owns ExecutionTarget/task authorization. Hub never stores
provider credentials or transcript content. Existing Relay, local UI, and
legacy Multica runtimes are unchanged when Hub is not configured.
