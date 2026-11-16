"""Local Nutshell mint on FakeWallet (no real sats) for tests and the demo.

Usage: .venv/bin/python mint-local/mint.py <port> [honest|double-spend|keyset]
- double-spend: never records spent proofs, so it accepts a token twice (NUT-03/07 broken).
- keyset: publishes swapped public keys, so keyset ids no longer derive from the keys (NUT-02 broken).
"""
import os
import sys
import tempfile

port, mode = sys.argv[1], (sys.argv[2] if len(sys.argv) > 2 else "honest")
os.environ.update(
    MINT_BACKEND_BOLT11_SAT="FakeWallet",
    FAKEWALLET_BRR="true",
    # The melt pays one of the mint's own invoices; it must still be unpaid when the melt lands.
    FAKEWALLET_DELAY_INCOMING_PAYMENT="2",
    FAKEWALLET_DELAY_OUTGOING_PAYMENT="0",
    MINT_PRIVATE_KEY=f"auditorcillo-demo-{mode}",  # FakeWallet only: the key guards nothing of value
    MINT_DATABASE=tempfile.mkdtemp(prefix=f"auditorcillo-mint-{mode}-"),
    MINT_LISTEN_PORT=port,
    MINT_INFO_NAME=f"Auditorcillo local ({mode})",
    MINT_INFO_DESCRIPTION="Local test mint with FakeWallet",
    MINT_INFO_CONTACT='[["nostr","npub1auditorcillo"]]',
)
sys.argv = sys.argv[:1]

from cashu.core.base import MintKeyset  # noqa: E402  (settings read the env above on import)
from cashu.mint.crud import LedgerCrudSqlite  # noqa: E402
from cashu.mint.main import main  # noqa: E402

if mode == "double-spend":

    async def forget_spent(*args, **kwargs):
        return None

    LedgerCrudSqlite.invalidate_proof = forget_spent
elif mode == "keyset":
    honest_keys = MintKeyset.public_keys_hex.fget

    def swapped_keys(self):
        keys = honest_keys(self)
        amounts = sorted(keys)
        keys[amounts[0]], keys[amounts[1]] = keys[amounts[1]], keys[amounts[0]]
        return keys

    MintKeyset.public_keys_hex = property(swapped_keys)
elif mode != "honest":
    sys.exit(f"unknown mode {mode}")

main()
