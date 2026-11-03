import * as base from "../core/base";

const RESOURCECOMPILER_SUMMARY =
  /^\s*(?:[A-Z][A-Z ]*:\s*)?\d+\s+compiled,\s*(\d+)\s+failed,\s*\d+\s+skipped(?:,\s*[^\r\n]*)?\s*$/im;
const S2V_FAILURE = /^\s*(\d+)\s+file\(s\)\s+failed to process\.\s*$/im;

export function resourcecompiler(returncode: number, out: Buffer | string): void {
  if (returncode !== 0) throw new Error(`resourcecompiler exited with code ${returncode}. See ${base.logRescomp} for details.`);
  const summary = out.toString("latin1").match(RESOURCECOMPILER_SUMMARY);
  if (!summary) throw new Error(`resourcecompiler did not report a compilation summary. See ${base.logRescomp}.`);
  const failed = Number(summary[1]);
  if (failed) throw new Error(`resourcecompiler failed to compile ${failed} resource(s). See ${base.logRescomp} for details.`);
}

export function source2viewer(returncode: number, out: Buffer | string): void {
  if (returncode !== 0) throw new Error(`Source2Viewer exited with code ${returncode}. See ${base.logS2v} for details.`);
  const failure = out.toString("latin1").match(S2V_FAILURE);
  if (failure && Number(failure[1])) {
    throw new Error(`Source2Viewer failed to decompile ${failure[1]} file(s). See ${base.logS2v} for details.`);
  }
}
