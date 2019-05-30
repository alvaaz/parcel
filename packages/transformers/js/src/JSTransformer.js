// @flow

import semver from 'semver';
import generate from '@babel/generator';
import {Transformer} from '@parcel/plugin';
import collectDependencies from './visitors/dependencies';
import envVisitor from './visitors/env';
import fsVisitor from './visitors/fs';
import insertGlobals from './visitors/globals';
import {parse} from '@babel/parser';
import traverse from '@babel/traverse';
import * as walk from 'babylon-walk';
import * as babelCore from '@babel/core';
import {hoist} from '@parcel/scope-hoisting';

const IMPORT_RE = /\b(?:import\b|export\b|require\s*\()/;
const ENV_RE = /\b(?:process\.env)\b/;
const GLOBAL_RE = /\b(?:process|__dirname|__filename|global|Buffer|define)\b/;
const FS_RE = /\breadFileSync\b/;
const SW_RE = /\bnavigator\s*\.\s*serviceWorker\s*\.\s*register\s*\(/;
const WORKER_RE = /\bnew\s*(?:Shared)?Worker\s*\(/;

// Sourcemap extraction
// const SOURCEMAP_RE = /\/\/\s*[@#]\s*sourceMappingURL\s*=\s*([^\s]+)/;
// const DATA_URL_RE = /^data:[^;]+(?:;charset=[^;]+)?;base64,(.*)/;

function canHaveDependencies(code) {
  return (
    IMPORT_RE.test(code) ||
    GLOBAL_RE.test(code) ||
    SW_RE.test(code) ||
    WORKER_RE.test(code)
  );
}

export default new Transformer({
  canReuseAST({ast}) {
    return ast.type === 'babel' && semver.satisfies(ast.version, '^7.0.0');
  },

  async parse({asset, options}) {
    let code = await asset.getCode();
    if (
      !options.scopeHoist &&
      !canHaveDependencies(code) &&
      !ENV_RE.test(code) &&
      !FS_RE.test(code)
    ) {
      return null;
    }

    return {
      type: 'babel',
      version: '7.0.0',
      isDirty: false,
      program: parse(code, {
        filename: this.name,
        allowReturnOutsideFunction: true,
        strictMode: false,
        sourceType: 'module',
        plugins: ['exportDefaultFrom', 'exportNamespaceFrom', 'dynamicImport']
      })
    };
  },

  async transform({asset, options}) {
    asset.type = 'js';
    if (!asset.ast) {
      return [asset];
    }

    let ast = asset.ast;
    let code = await asset.getCode();

    // Inline environment variables
    if (!asset.env.isNode() && ENV_RE.test(code)) {
      walk.simple(ast.program, envVisitor, asset);
    }

    // Collect dependencies
    if (canHaveDependencies(code) || ast.isDirty) {
      walk.ancestor(ast.program, collectDependencies, asset);
    }

    if (asset.env.isNode()) {
      // If there's a hashbang, remove it and store it on the asset meta.
      // During packaging, if this is the entry asset, it will be prepended to the
      // packaged output.
      if (ast.program.program.interpreter != null) {
        asset.meta.interpreter = ast.program.program.interpreter.value;
        delete ast.program.program.interpreter;
      }
    } else {
      // Inline fs calls
      let fsDep = asset
        .getDependencies()
        .find(dep => dep.moduleSpecifier === 'fs');
      if (fsDep && FS_RE.test(code)) {
        // Check if we should ignore fs calls
        // See https://github.com/defunctzombie/node-browser-resolve#skip
        let pkg = await asset.getPackage();
        let ignore =
          pkg &&
          pkg.browser &&
          typeof pkg.browser === 'object' &&
          pkg.browser.fs === false;

        if (!ignore) {
          traverse(ast.program, fsVisitor, null, asset);
        }
      }

      // Insert node globals
      if (GLOBAL_RE.test(code)) {
        asset.meta.globals = new Map();
        walk.ancestor(ast.program, insertGlobals, asset);
      }
    }

    if (options.scopeHoist) {
      hoist(asset);
    } else if (asset.meta.isES6Module) {
      // Convert ES6 modules to CommonJS
      let res = babelCore.transformFromAst(ast.program, code, {
        code: false,
        ast: true,
        filename: asset.filePath,
        babelrc: false,
        configFile: false,
        plugins: [require('@babel/plugin-transform-modules-commonjs')]
      });

      ast.program = res.ast;
      ast.isDirty = true;
    }

    return [asset];
  },

  async generate({asset}) {
    let code = await asset.getCode();
    let res = {
      code
    };

    if (asset.ast && asset.ast.isDirty !== false) {
      let generated = generate(
        asset.ast.program,
        {
          // sourceMaps: options.sourceMaps,
          // sourceFileName: asset.relativeName
        },
        code
      );

      res.code = generated.code;
      // res.map = generated.map;
    }

    if (asset.meta.globals && asset.meta.globals.size > 0) {
      res.code =
        Array.from(asset.meta.globals.values())
          .map(g => (g ? g.code : ''))
          .join('\n') +
        '\n' +
        res.code;
    }
    delete asset.meta.globals;
    return res;
  }
});
