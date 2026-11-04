/**
 * Where does the local model run? Two sources, and the startup says which one it used:
 *   1. nvidia-smi — on PATH, else its standard places (C:\Windows\System32, C:\Program Files\NVIDIA Corporation\NVSMI).
 *      It answering with an error ("…failed because you do not have sufficient permissions") still means an NVIDIA
 *      driver is installed: "GPU present, details unavailable" — not "no GPU".
 *   2. Ollama's own report after loading the model (`ollama ps`, PROCESSOR column; /api/ps: size vs size_vram).
 *      This is the verdict: a warning only when Ollama really runs the model (partly) on the CPU.
 */
import { spawnSync } from 'node:child_process';

export type NvidiaProbe =
  | { present: true; vramMb: number; method: string }
  | { present: true; vramMb: null; method: string; note: string }
  | { present: false; method: string; note: string };

export const NVIDIA_SMI_PLACES = ['nvidia-smi', 'C:\\Windows\\System32\\nvidia-smi.exe', 'C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe'];

export interface RunResult {
  /** the program does not exist there */
  missing: boolean;
  status: number | null;
  out: string;
}
const runSmi = (exe: string): RunResult => {
  const r = spawnSync(exe, ['--query-gpu=memory.total', '--format=csv,noheader,nounits'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  const err = r.error as NodeJS.ErrnoException | undefined;
  return { missing: err?.code === 'ENOENT', status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
};

/** nvidia-smi at each place in turn; the first one that exists decides. */
export function probeNvidiaSmi(run: (exe: string) => RunResult = runSmi, places = NVIDIA_SMI_PLACES): NvidiaProbe {
  for (const exe of places) {
    const r = run(exe);
    if (r.missing) continue;
    const where = exe === 'nvidia-smi' ? 'nvidia-smi on PATH' : exe;
    const vals = r.status === 0 ? r.out.split(/\r?\n/).map((l) => Number(l.trim())).filter((n) => n > 0) : [];
    if (vals.length) return { present: true, vramMb: Math.max(...vals), method: where };
    // it ran but gave no numbers: a driver is there; the details are not available
    const first = r.out.split(/\r?\n/).find((l) => l.trim()) ?? `exit ${r.status ?? '?'}`;
    const note = /sufficient permissions/i.test(first) ? 'insufficient permissions — details unavailable' : `details unavailable: ${first.slice(0, 120)}`;
    return { present: true, vramMb: null, method: where, note };
  }
  return { present: false, method: `nvidia-smi (PATH, ${NVIDIA_SMI_PLACES.slice(1).join(', ')})`, note: 'not found' };
}

export interface OllamaPlacement {
  /** gpu = all in VRAM, cpu = none, split = part of it */
  where: 'gpu' | 'cpu' | 'split';
  /** as `ollama ps` prints it: "100% GPU", "100% CPU", "35%/65% CPU/GPU" */
  processor: string;
  sizeMb: number;
}

/** `ollama ps`'s PROCESSOR column from /api/ps's size and size_vram. */
export function placement(size: number, sizeVram: number): OllamaPlacement {
  const sizeMb = Math.round(size / 1024 / 1024);
  if (!size || sizeVram <= 0) return { where: 'cpu', processor: '100% CPU', sizeMb };
  if (sizeVram >= size) return { where: 'gpu', processor: '100% GPU', sizeMb };
  const gpu = Math.round((sizeVram / size) * 100);
  return { where: 'split', processor: `${100 - gpu}%/${gpu}% CPU/GPU`, sizeMb };
}

type PsModel = { name: string; model?: string; size: number; size_vram: number };
const same = (a: string, b: string) => a === b || a === `${b}:latest` || b === `${a}:latest`;

/**
 * Loads the model in Ollama (an empty prompt only loads it) unless it is loaded already, then reads where it runs.
 * Null with a reason when Ollama cannot tell (not reachable, the load failed or timed out).
 */
export async function ollamaPlacement(baseUrl: string, model: string, opts: { fetchImpl?: typeof fetch; loadTimeoutMs?: number } = {}): Promise<{ ok: true; placement: OllamaPlacement; loaded: boolean } | { ok: false; reason: string }> {
  const f = opts.fetchImpl ?? fetch;
  const ps = async () => ((await (await f(`${baseUrl}/api/ps`, { signal: AbortSignal.timeout(5000) })).json()) as { models?: PsModel[] }).models ?? [];
  try {
    let m = (await ps()).find((x) => same(x.name, model) || same(x.model ?? '', model));
    let loaded = false;
    if (!m) {
      const r = await f(`${baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, prompt: '', stream: false, keep_alive: '10m' }),
        signal: AbortSignal.timeout(opts.loadTimeoutMs ?? 180_000),
      });
      if (!r.ok) return { ok: false, reason: `loading ${model} failed (HTTP ${r.status})` };
      loaded = true;
      m = (await ps()).find((x) => same(x.name, model) || same(x.model ?? '', model));
    }
    if (!m) return { ok: false, reason: `${model} is not in ollama ps after loading` };
    return { ok: true, placement: placement(m.size, m.size_vram), loaded };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message.split('\n')[0]! : String(e) };
  }
}

export interface GpuVerdict {
  level: 'ok' | 'info' | 'warn';
  text: string;
}

/** The startup line for one model: Ollama's report decides; nvidia-smi only when Ollama cannot tell. */
export function gpuVerdict(model: string, nvidia: NvidiaProbe, ollama: Awaited<ReturnType<typeof ollamaPlacement>>, modelSizeMb: number): GpuVerdict {
  const smi = !nvidia.present ? `no NVIDIA GPU found (${nvidia.method})` : nvidia.vramMb !== null ? `NVIDIA GPU, ${(nvidia.vramMb / 1024).toFixed(1)} GB (${nvidia.method})` : `NVIDIA GPU present, ${nvidia.note} (${nvidia.method})`;
  if (ollama.ok) {
    const p = ollama.placement;
    const via = `ollama ps: ${p.processor}`;
    if (p.where === 'gpu') return { level: 'ok', text: `${model} runs on the GPU (${via}) · ${smi}` };
    if (p.where === 'split') return { level: 'warn', text: `${model} runs partly on the CPU (${via}) — slower; a smaller model fits fully · ${smi}` };
    return { level: 'warn', text: `${model} runs on the CPU (${via}) — slow · ${smi}` };
  }
  // Ollama could not tell: nvidia-smi only
  if (nvidia.present && nvidia.vramMb !== null) {
    if (modelSizeMb > nvidia.vramMb * 0.9) return { level: 'warn', text: `${model} (${(modelSizeMb / 1024).toFixed(1)} GB) does not fit the GPU (${(nvidia.vramMb / 1024).toFixed(1)} GB, ${nvidia.method}); Ollama could not confirm (${ollama.reason})` };
    return { level: 'ok', text: `${model} fits the GPU (${(modelSizeMb / 1024).toFixed(1)} of ${(nvidia.vramMb / 1024).toFixed(1)} GB, ${nvidia.method}); Ollama could not confirm (${ollama.reason})` };
  }
  if (nvidia.present) return { level: 'info', text: `${smi}; Ollama could not confirm where ${model} runs (${ollama.reason})` };
  return { level: 'warn', text: `${smi}, and Ollama could not confirm where ${model} runs (${ollama.reason}) — it may run slowly on the CPU` };
}
