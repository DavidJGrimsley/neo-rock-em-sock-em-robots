const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const app = require('../app.json').expo;

function configure(env) {
  const module = { exports: {} };
  vm.runInNewContext(
    ts.transpileModule(fs.readFileSync(require.resolve('../app.config.ts'), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS },
    }).outputText,
    { module, exports: module.exports, process: { env }, URL }
  );
  return module.exports.default({ config: app });
}

test('native replication and runtime multiplayer require the same complete configuration', () => {
  for (const env of [
    {},
    { RV_API_KEY: 'test-key' },
    { RV_PROJECT_ID: 'test-project' },
    { RV_API_KEY: 'test-key', RV_PROJECT_ID: '' },
    { RV_API_KEY: '   ', RV_PROJECT_ID: 'test-project' },
    { RV_API_KEY: 'test-key', RV_PROJECT_ID: '   ' },
  ]) {
    const config = configure(env);
    const viro = config.plugins.find((plugin) => plugin[0] === '@reactvision/react-viro');
    assert.equal(viro[1].provider, 'none');
    assert.equal(config.extra.arenaMultiplayer, undefined);
  }
  const config = configure({ RV_API_KEY: ' test-key ', RV_PROJECT_ID: ' test-project ' });
  const viro = config.plugins.find((plugin) => plugin[0] === '@reactvision/react-viro');
  assert.equal(viro[1].provider, 'reactvision');
  assert.equal(viro[1].rvApiKey, 'test-key');
  assert.equal(config.extra.arenaMultiplayer.apiKey, 'test-key');
  assert.equal(config.extra.arenaMultiplayer.projectId, 'test-project');
});

test('runtime configuration rejects empty or whitespace-only values', () => {
  const code = ts.transpileModule(
    fs.readFileSync(require.resolve('../src/features/arena-fighter/arena-configuration.ts'), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS } }
  ).outputText;
  for (const values of [
    { apiKey: 'test-key', projectId: '' },
    { apiKey: 'test-key', projectId: '   ' },
    { apiKey: '   ', projectId: 'test-project' },
    { apiKey: ' test-key ', projectId: ' test-project ' },
  ]) {
    const module = { exports: {} };
    vm.runInNewContext(code, {
      module,
      exports: module.exports,
      require: () => ({ __esModule: true, default: { expoConfig: { extra: { arenaMultiplayer: values } } } }),
    });
    const config = module.exports.arenaConfiguration();
    if (!values.apiKey.trim() || !values.projectId.trim()) assert.equal(config, null);
    else {
      assert.equal(config.apiKey, 'test-key');
      assert.equal(config.projectId, 'test-project');
    }
  }
});

test('invitation scheme matches the registered standalone app scheme', () => {
  const { joinLink } = require('../src/features/arena-fighter/arena-protocol.ts');
  assert.equal(new URL(joinLink('ABC234')).protocol, app.scheme + ':');
});
