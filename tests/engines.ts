export const Engine = {
    Chromium: 'chromium',
    Firefox : 'firefox',
    WebKit  : 'webkit',
} as const;

export type Engine = typeof Engine[keyof typeof Engine];
