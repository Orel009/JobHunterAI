/**
 * Where the local model runs: nvidia-smi on PATH, then its standard places; an error from it ("insufficient
 * permissions") = GPU present, details unavailable; Ollama's own report (ollama ps) decides, and only CPU warns.
 */
import { describe, expect, it } from 'vitest';
import { gpuVerdict, ollamaPlacement, placement, probeNvidiaSmi, type RunResult } from '../src/llm/gpu.js';

const PERM = 'NVIDIA-SMI has failed because you do not have sufficient permissions. Please try running as an administrator.';
const runs = (m: Record<string, RunResult>) => (exe: string): RunResult => m[exe] ?? { missing: true, status: null, out: '' };

describe('nvidia-smi', () => {
  it('on PATH with numbers → VRAM', () => {
    expect(probeNvidiaSmi(runs({ 'nvidia-smi': { missing: false, status: 0, out: '12282\n' } }))).toEqual({ present: true, vramMb: 12282, method: 'nvidia-smi on PATH' });
  });
  it('not on PATH → System32, then NVSMI', () => {
    expect(probeNvidiaSmi(runs({ 'C:\\Windows\\System32\\nvidia-smi.exe': { missing: false, status: 0, out: '8192' } }))).toMatchObject({ vramMb: 8192, method: 'C:\\Windows\\System32\\nvidia-smi.exe' });
    expect(probeNvidiaSmi(runs({ 'C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe': { missing: false, status: 0, out: '6144' } }))).toMatchObject({ vramMb: 6144 });
  });
  it('"insufficient permissions" → GPU present, details unavailable (not "no GPU")', () => {
    expect(probeNvidiaSmi(runs({ 'nvidia-smi': { missing: false, status: 4, out: PERM } }))).toEqual({ present: true, vramMb: null, method: 'nvidia-smi on PATH', note: 'insufficient permissions — details unavailable' });
  });
  it('nowhere → not found, saying where it looked', () => {
    expect(probeNvidiaSmi(runs({}))).toMatchObject({ present: false, method: expect.stringMatching(/PATH, C:\\Windows\\System32\\nvidia-smi\.exe, C:\\Program Files\\NVIDIA Corporation\\NVSMI/) });
  });
});

describe("Ollama's report", () => {
  it('the PROCESSOR column, as ollama ps prints it', () => {
    expect(placement(6_400_000_000, 6_400_000_000).processor).toBe('100% GPU');
    expect(placement(6_400_000_000, 0)).toMatchObject({ where: 'cpu', processor: '100% CPU' });
    expect(placement(1000, 650)).toMatchObject({ where: 'split', processor: '35%/65% CPU/GPU' });
  });
  it('loads the model when it is not loaded, then reads /api/ps', async () => {
    const calls: string[] = [];
    let loaded = false;
    const f = (async (u: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${u}`);
      if (u.endsWith('/api/generate')) loaded = true;
      return new Response(JSON.stringify(u.endsWith('/api/ps') ? { models: loaded ? [{ name: 'gemma4:12b', size: 6_400_000_000, size_vram: 0 }] : [] } : {}), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await ollamaPlacement('http://o', 'gemma4:12b', { fetchImpl: f })).toMatchObject({ ok: true, loaded: true, placement: { where: 'cpu', processor: '100% CPU' } });
    expect(calls).toEqual(['GET http://o/api/ps', 'POST http://o/api/generate', 'GET http://o/api/ps']);
  });
});

describe('the verdict', () => {
  const perm = probeNvidiaSmi(runs({ 'nvidia-smi': { missing: false, status: 4, out: PERM } }));
  const gpuPs = { ok: true as const, loaded: false, placement: placement(10, 10) };
  const cpuPs = { ok: true as const, loaded: true, placement: placement(10, 0) };
  it('permissions error + Ollama on the GPU → ok, no warning', () => {
    expect(gpuVerdict('gemma4:12b', perm, gpuPs, 6000)).toEqual({ level: 'ok', text: 'gemma4:12b runs on the GPU (ollama ps: 100% GPU) · NVIDIA GPU present, insufficient permissions — details unavailable (nvidia-smi on PATH)' });
  });
  it('Ollama on the CPU → the warning, with both sources', () => {
    expect(gpuVerdict('gemma4:12b', perm, cpuPs, 6000)).toMatchObject({ level: 'warn', text: expect.stringMatching(/^gemma4:12b runs on the CPU \(ollama ps: 100% CPU\)/) });
  });
  it('Ollama cannot tell: GPU present without details → information only; nothing found → a warning', () => {
    expect(gpuVerdict('m', perm, { ok: false, reason: 'timeout' }, 6000).level).toBe('info');
    expect(gpuVerdict('m', probeNvidiaSmi(runs({})), { ok: false, reason: 'timeout' }, 6000).level).toBe('warn');
    expect(gpuVerdict('m', { present: true, vramMb: 4096, method: 'nvidia-smi on PATH' }, { ok: false, reason: 'x' }, 6000).text).toMatch(/does not fit the GPU/);
  });
});
