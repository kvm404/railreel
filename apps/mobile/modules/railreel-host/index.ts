// Re-export the native module. On web, it will be resolved to RailReelHostModule.web.ts
// and on native platforms to RailReelHostModule.ts
export { default } from './src/RailReelHostModule';
export * from './src/RailReelHost.types';
