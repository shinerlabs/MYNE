# Bounds-safe bigint-buffer shim

`bigint-buffer` 1.1.5 has an unpatched native-addon buffer-overflow advisory. MYNE uses this
minimal pure-JavaScript compatibility shim for the four conversion functions required by the
Solana JavaScript dependency graph. It intentionally has no native addon or install script and
rejects invalid buffers, widths, negative integers, and values that do not fit the requested width.
