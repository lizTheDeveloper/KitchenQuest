// Content types. Step 3 defines BureauForm (needed by the Bureau form component);
// Step 4 adds the rest of this file.
export interface BureauFormField { key: string; label: string; hint?: string }

export interface BureauForm {
  number: string;
  title: string;
  title_aside?: string;
  safety?: boolean;
  fields: BureauFormField[];
  buttons: { confirm: string; decline?: string };
  /** Key into the Bureau file's `stamps` map. */
  stamp: string;
  footnotes?: string[];
}
