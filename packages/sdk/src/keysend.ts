import type { Hex } from '@tainnel/protocol';
import nacl from 'tweetnacl';
import { bytesToHex, hexToBytes } from './crypto.js';
import type { KeysendPayload } from './hub-protocol.js';

export function generateKeysendKeypair(): { publicKey: Hex; secretKey: Hex } {
  const kp = nacl.box.keyPair();
  return { publicKey: bytesToHex(kp.publicKey), secretKey: bytesToHex(kp.secretKey) };
}

export function sealForRecipient(
  payload: Record<string, unknown>,
  recipientPubkey: Hex,
): KeysendPayload {
  const ephemeral = nacl.box.keyPair();
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const message = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext = nacl.box(message, nonce, hexToBytes(recipientPubkey), ephemeral.secretKey);
  return {
    ciphertext: bytesToHex(ciphertext),
    ephemeralPubkey: bytesToHex(ephemeral.publicKey),
    nonce: bytesToHex(nonce),
  };
}

export function openSealed(
  envelope: KeysendPayload,
  recipientSecretKey: Hex,
): Record<string, unknown> {
  const opened = nacl.box.open(
    hexToBytes(envelope.ciphertext),
    hexToBytes(envelope.nonce),
    hexToBytes(envelope.ephemeralPubkey),
    hexToBytes(recipientSecretKey),
  );
  if (!opened) throw new Error('keysend: failed to decrypt sealed payload');
  return JSON.parse(new TextDecoder().decode(opened));
}
