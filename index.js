var fs = require("fs");
var path = require("path");
var Walker = require('node-source-walk');
var q = require('q');
var walkdir = require("walkdir");
var _ = require('lodash');
var minimatch = require('minimatch');
var util = require('util');
var acorn = require('acorn-jsx');

function getArgumentFromCall(node) {
  return node.type === 'CallExpression' && node.arguments[0]
    ? node.arguments[0].value
    : undefined;
}

function isRequireFunction(node) {
  var callee = node.callee;
  return callee && callee.type === 'Identifier' && callee.name === 'require' &&
    getArgumentFromCall(node);
}

function isGruntLoadTaskCall(node) {
  var callee = node.callee;
  return callee && callee.property && callee.property.name === 'loadNpmTasks' &&
    getArgumentFromCall(node);
}

function isImportDeclaration(node) {
  return node.type === 'ImportDeclaration' && node.source && node.source.value;
}

function getModulesRequiredFromFilename(filename, jsx) {
  var content = fs.readFileSync(filename, "utf-8");
  if (!content) {
    throw new TypeError('cannot read from file ' + filename);
  }

  var walker = new Walker();
  var dependencies = [];
  var ast;

  try {
    ast = acorn.parse(content, {
      ecmaVersion: 6,
      sourceType: 'module',
      allowHashBang: true,
      plugins: { jsx: jsx }
    });
  } catch (err) { // SyntaxError
    return [];
  }

  walker.walk(ast, function(node) {
    if (isRequireFunction(node) || isGruntLoadTaskCall(node)) {
      dependencies.push(getArgumentFromCall(node));
    } else if (isImportDeclaration(node)) {
      dependencies.push(node.source.value);
    }
  });

  return dependencies;
}

function checkDirectory(dir, ignoreDirs, deps, devDeps, extensions, jsx) {

  var deferred = q.defer();
  var directoryPromises = [];
  var finder = walkdir(dir, { "no_recurse": true });
  var invalidFiles = {};

  finder.on("directory", function (subdir) {
    if (_.contains(ignoreDirs, path.basename(subdir))
      || (_.isEmpty(deps) && _.isEmpty(devDeps)))  {
        return;
    }

    directoryPromises.push(checkDirectory(subdir, ignoreDirs, deps, devDeps, extensions, jsx));
  });

  finder.on("file", function (filename) {
    if (extensions.indexOf(path.extname(filename)) !== -1) {
      var modulesRequired = getModulesRequiredFromFilename(filename, jsx);
      if (util.isError(modulesRequired)) {
        invalidFiles[filename] = modulesRequired;
      } else {
        modulesRequired = modulesRequired.map(function (module) {
          return module.replace ? module.replace(/\/.*$/, '') : module;
        });
        deps = _.difference(deps, modulesRequired);
        devDeps = _.difference(devDeps, modulesRequired);
      }
    }
  });

  finder.on("end", function () {
    deferred.resolve(q.allSettled(directoryPromises).then(function(directoryResults) {

      _.each(directoryResults, function(result) {
        if (result.state === 'fulfilled') {
          invalidFiles = _.merge(invalidFiles, result.value.invalidFiles, {});
          deps = _.intersection(deps, result.value.dependencies);
          devDeps = _.intersection(devDeps, result.value.devDependencies);
        }
      });

      return {
        dependencies: deps,
        devDependencies: devDeps,
        invalidFiles: invalidFiles
      };
    }));
  });

  return deferred.promise;
}

function depCheck(rootDir, options, cb) {

  var pkg = options.package || require(path.join(rootDir, 'package.json'));
  var deps = filterDependencies(pkg.dependencies);
  var devDeps = filterDependencies(options.withoutDev ? [] : pkg.devDependencies);
  var extensions = options.extensions || ['.js'];
  var ignoreDirs = _([
      '.git',
      '.svn',
      '.hg',
      '.idea',
      'node_modules',
      'bower_components'
    ])
    .concat(options.ignoreDirs)
    .flatten()
    .unique()
    .valueOf();

  function isIgnored(dependency) {
    return _.any(options.ignoreMatches, function(match) {
      return minimatch(dependency, match);
    });
  }

  function hasBin(dependency) {
    try {
      var depPkg = require(path.join(rootDir, "node_modules", dependency, "package.json"));
      return _.has(depPkg, 'bin');
    } catch (e) {}
  }

  function filterDependencies(dependencies) {
    return _(dependencies)
      .keys()
      .reject(hasBin)
      .reject(isIgnored)
      .valueOf();
  }

  return checkDirectory(rootDir, ignoreDirs, deps, devDeps, extensions, options.jsx)
    .then(cb)
    .done();
}

module.exports = depCheck;
