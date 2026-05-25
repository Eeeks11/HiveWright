import { buildSetupGuide, writeEnvTemplateIfRequested } from "../src/setup-doctor/reliability";

function parseArgs(argv: string[]) {
  return {
    writeEnvTemplate: argv.includes("--write-env-template"),
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const guide = buildSetupGuide(options);
  console.log(guide.markdown);

  if (options.writeEnvTemplate) {
    const result = writeEnvTemplateIfRequested({ writeEnvTemplate: true });
    console.log(`\nWrote env template: ${result.path}`);
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : "setup failed");
  process.exitCode = 1;
}
