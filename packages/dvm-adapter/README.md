# @inferenceroom/pico-dvm-adapter

Glue between pico payment channels and Nostr Data Vending Machines (DVMs). Encodes
and decodes payment options inside DVM event tags, picks between on-chain and
in-channel payment for a given quote, and offers a thin relay listener so clients can
react to DVM tasks without wiring up Nostr themselves.

Use it from any environment that already has `@inferenceroom/pico-sdk` configured.
