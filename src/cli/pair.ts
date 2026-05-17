/**
 * openclaw-voice pair — device pairing stub.
 */

export function pair(): void {
  process.stdout.write(
    "Device pairing flow not yet implemented.\n" +
    "For now, configure `gateway.auth.token` in openclaw.json and pass\n" +
    "--device-token or set OPENCLAW_DEVICE_TOKEN.\n",
  );
  process.exit(0);
}
