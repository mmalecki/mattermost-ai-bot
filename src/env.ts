// The working directory's .env, when there is one, however the bot is started. Imported first, so it's
// in the environment before any other module loads, as with node's --env-file. Variables already set win.
try {
  process.loadEnvFile();
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}
