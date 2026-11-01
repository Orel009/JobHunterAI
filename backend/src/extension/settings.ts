/**
 * JobHunter Fill settings (data/settings.json → extension): whether the extension fills cover letters / messages to the
 * hiring team with a reviewed-by-you AI draft (default on; you always submit yourself there). The automated sites
 * (Drushim, JobMaster, Jobnet, JobKarov) keep cover letters empty whatever this says.
 */
import { readSettingsFile, writeSettingsFile } from '../llm/settings.js';

export interface ExtensionSettings {
  fillCoverLetters: boolean;
  /** 2–3 messages you wrote yourself: the style reference for the drafts ('' = none) */
  styleSample: string;
}
type WithExt = { extension?: Partial<ExtensionSettings> };

export function extensionSettings(): ExtensionSettings {
  const s = (readSettingsFile() as WithExt).extension ?? {};
  return { fillCoverLetters: s.fillCoverLetters !== false, styleSample: typeof s.styleSample === 'string' ? s.styleSample : '' };
}

export function saveExtensionSettings(patch: Partial<ExtensionSettings>): ExtensionSettings {
  const file = readSettingsFile();
  writeSettingsFile({ ...file, extension: { ...extensionSettings(), ...patch } } as typeof file);
  return extensionSettings();
}
