import { format, type Message, type Texts } from "/p/the8020/i18n/messages.ts";
import english from "./locales/en.json" with { type: "json" };
let texts: Texts = english.texts;
export function setTexts(value: unknown): void {
  texts = value as Texts ?? english.texts;
}
export function t(key: string, vars?: Message["vars"]): string {
  return format(texts, key, vars);
}
