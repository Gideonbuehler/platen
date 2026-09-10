const { getDefaultConfig } = require('expo/metro-config');

/**
 * Standard Expo Metro config.
 *
 * The mobile app deliberately does not consume the `@aperture/shared` workspace
 * package: Metro's monorepo resolution needs watchFolders plus nodeModulesPaths
 * tuning, and it breaks in confusing ways on Windows. The handful of API types
 * the app needs are mirrored in src/types.ts instead, with the shared package
 * documented there as the source of truth.
 */
const config = getDefaultConfig(__dirname);

module.exports = config;
