import english from "./locales/en.json" with { type: "json" };

/** Carries a presentation key across the standalone sandbox process boundary. */
export class DevelopmentError extends Error {
  constructor(readonly textKey: string) {
    super((english.texts as Record<string, string>)[textKey] ?? textKey);
  }
}
