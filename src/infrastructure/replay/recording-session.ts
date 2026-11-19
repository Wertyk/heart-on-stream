/** Both explicit opt-ins are evaluated before StreamSession starts the recorder. */
export function shouldRecordSession(flag: boolean, toggle: boolean): boolean {
  return flag || toggle;
}
