export type MetricKind = 'counter' | 'gauge';

export interface MetricSpec {
  readonly name: string;
  readonly help: string;
  readonly kind: MetricKind;
}

export const METRIC_SPECS: Record<string, MetricSpec> = {
  channelsWatched: {
    name: 'tainnel_watchtower_channels_watched',
    help: 'Number of channels under observation by this watchtower',
    kind: 'gauge',
  },
  penaltiesSubmittedTotal: {
    name: 'tainnel_watchtower_penalties_submitted_total',
    help: 'Total penalty proofs submitted (cumulative)',
    kind: 'counter',
  },
  evaluationsTotal: {
    name: 'tainnel_watchtower_evaluations_total',
    help: 'Total channel-state evaluations performed',
    kind: 'counter',
  },
  rpcUp: {
    name: 'tainnel_watchtower_rpc_up',
    help: 'RPC connectivity gauge (1 = up, 0 = down)',
    kind: 'gauge',
  },
};

export class WatchtowerMetrics {
  private values: Record<string, number> = {
    channelsWatched: 0,
    penaltiesSubmittedTotal: 0,
    evaluationsTotal: 0,
    rpcUp: 0,
  };

  inc(key: keyof typeof this.values, by = 1): void {
    this.values[key] = (this.values[key] ?? 0) + by;
  }

  set(key: keyof typeof this.values, v: number): void {
    this.values[key] = v;
  }

  get(key: keyof typeof this.values): number {
    return this.values[key] ?? 0;
  }

  exposition(): string {
    const lines: string[] = [];
    for (const [key, spec] of Object.entries(METRIC_SPECS)) {
      const v = this.values[key] ?? 0;
      lines.push(`# HELP ${spec.name} ${spec.help}`);
      lines.push(`# TYPE ${spec.name} ${spec.kind}`);
      lines.push(`${spec.name} ${v}`);
    }
    return `${lines.join('\n')}\n`;
  }
}
