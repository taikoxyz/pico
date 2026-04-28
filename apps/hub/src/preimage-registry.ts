import type { Hex } from '@tainnel/protocol';

export class PreimageRegistry {
  private readonly map = new Map<string, Hex>();

  register(paymentHash: Hex, preimage: Hex): void {
    this.map.set(paymentHash.toLowerCase(), preimage);
  }

  has(paymentHash: Hex): boolean {
    return this.map.has(paymentHash.toLowerCase());
  }

  get(paymentHash: Hex): Hex | undefined {
    return this.map.get(paymentHash.toLowerCase());
  }

  delete(paymentHash: Hex): void {
    this.map.delete(paymentHash.toLowerCase());
  }

  size(): number {
    return this.map.size;
  }
}
