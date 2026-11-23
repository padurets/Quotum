/**
 * A message is text with `{placeholders}`, or plural forms picked by the `count`
 * parameter with `Intl.PluralRules` of the language ("one", "few", "many", "other"…).
 */
export type Message = string | ({other: string} & Partial<Record<Intl.LDMLPluralRule, string>>);
