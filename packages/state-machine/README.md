# @tainnel/state-machine

Pure-function library implementing the channel state-transition rules: balance updates,
HTLC add/settle/fail, version/replay protection, and EIP-712 hash construction. Every
function takes its inputs and returns the next state — there is **no I/O**, no chain
calls, and no key handling.

This isolation makes the rules trivially testable and keeps the same logic safe to use
inside watchtowers, hubs, and clients without divergence.
