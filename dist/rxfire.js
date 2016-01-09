"format cjs";
(function(global) {

  var defined = {};

  // indexOf polyfill for IE8
  var indexOf = Array.prototype.indexOf || function(item) {
    for (var i = 0, l = this.length; i < l; i++)
      if (this[i] === item)
        return i;
    return -1;
  }

  var getOwnPropertyDescriptor = true;
  try {
    Object.getOwnPropertyDescriptor({ a: 0 }, 'a');
  }
  catch(e) {
    getOwnPropertyDescriptor = false;
  }

  var defineProperty;
  (function () {
    try {
      if (!!Object.defineProperty({}, 'a', {}))
        defineProperty = Object.defineProperty;
    }
    catch (e) {
      defineProperty = function(obj, prop, opt) {
        try {
          obj[prop] = opt.value || opt.get.call(obj);
        }
        catch(e) {}
      }
    }
  })();

  function register(name, deps, declare) {
    if (arguments.length === 4)
      return registerDynamic.apply(this, arguments);
    doRegister(name, {
      declarative: true,
      deps: deps,
      declare: declare
    });
  }

  function registerDynamic(name, deps, executingRequire, execute) {
    doRegister(name, {
      declarative: false,
      deps: deps,
      executingRequire: executingRequire,
      execute: execute
    });
  }

  function doRegister(name, entry) {
    entry.name = name;

    // we never overwrite an existing define
    if (!(name in defined))
      defined[name] = entry;

    // we have to normalize dependencies
    // (assume dependencies are normalized for now)
    // entry.normalizedDeps = entry.deps.map(normalize);
    entry.normalizedDeps = entry.deps;
  }


  function buildGroups(entry, groups) {
    groups[entry.groupIndex] = groups[entry.groupIndex] || [];

    if (indexOf.call(groups[entry.groupIndex], entry) != -1)
      return;

    groups[entry.groupIndex].push(entry);

    for (var i = 0, l = entry.normalizedDeps.length; i < l; i++) {
      var depName = entry.normalizedDeps[i];
      var depEntry = defined[depName];

      // not in the registry means already linked / ES6
      if (!depEntry || depEntry.evaluated)
        continue;

      // now we know the entry is in our unlinked linkage group
      var depGroupIndex = entry.groupIndex + (depEntry.declarative != entry.declarative);

      // the group index of an entry is always the maximum
      if (depEntry.groupIndex === undefined || depEntry.groupIndex < depGroupIndex) {

        // if already in a group, remove from the old group
        if (depEntry.groupIndex !== undefined) {
          groups[depEntry.groupIndex].splice(indexOf.call(groups[depEntry.groupIndex], depEntry), 1);

          // if the old group is empty, then we have a mixed depndency cycle
          if (groups[depEntry.groupIndex].length == 0)
            throw new TypeError("Mixed dependency cycle detected");
        }

        depEntry.groupIndex = depGroupIndex;
      }

      buildGroups(depEntry, groups);
    }
  }

  function link(name) {
    var startEntry = defined[name];

    startEntry.groupIndex = 0;

    var groups = [];

    buildGroups(startEntry, groups);

    var curGroupDeclarative = !!startEntry.declarative == groups.length % 2;
    for (var i = groups.length - 1; i >= 0; i--) {
      var group = groups[i];
      for (var j = 0; j < group.length; j++) {
        var entry = group[j];

        // link each group
        if (curGroupDeclarative)
          linkDeclarativeModule(entry);
        else
          linkDynamicModule(entry);
      }
      curGroupDeclarative = !curGroupDeclarative; 
    }
  }

  // module binding records
  var moduleRecords = {};
  function getOrCreateModuleRecord(name) {
    return moduleRecords[name] || (moduleRecords[name] = {
      name: name,
      dependencies: [],
      exports: {}, // start from an empty module and extend
      importers: []
    })
  }

  function linkDeclarativeModule(entry) {
    // only link if already not already started linking (stops at circular)
    if (entry.module)
      return;

    var module = entry.module = getOrCreateModuleRecord(entry.name);
    var exports = entry.module.exports;

    var declaration = entry.declare.call(global, function(name, value) {
      module.locked = true;

      if (typeof name == 'object') {
        for (var p in name)
          exports[p] = name[p];
      }
      else {
        exports[name] = value;
      }

      for (var i = 0, l = module.importers.length; i < l; i++) {
        var importerModule = module.importers[i];
        if (!importerModule.locked) {
          for (var j = 0; j < importerModule.dependencies.length; ++j) {
            if (importerModule.dependencies[j] === module) {
              importerModule.setters[j](exports);
            }
          }
        }
      }

      module.locked = false;
      return value;
    }, entry.name);

    module.setters = declaration.setters;
    module.execute = declaration.execute;

    // now link all the module dependencies
    for (var i = 0, l = entry.normalizedDeps.length; i < l; i++) {
      var depName = entry.normalizedDeps[i];
      var depEntry = defined[depName];
      var depModule = moduleRecords[depName];

      // work out how to set depExports based on scenarios...
      var depExports;

      if (depModule) {
        depExports = depModule.exports;
      }
      else if (depEntry && !depEntry.declarative) {
        depExports = depEntry.esModule;
      }
      // in the module registry
      else if (!depEntry) {
        depExports = load(depName);
      }
      // we have an entry -> link
      else {
        linkDeclarativeModule(depEntry);
        depModule = depEntry.module;
        depExports = depModule.exports;
      }

      // only declarative modules have dynamic bindings
      if (depModule && depModule.importers) {
        depModule.importers.push(module);
        module.dependencies.push(depModule);
      }
      else
        module.dependencies.push(null);

      // run the setter for this dependency
      if (module.setters[i])
        module.setters[i](depExports);
    }
  }

  // An analog to loader.get covering execution of all three layers (real declarative, simulated declarative, simulated dynamic)
  function getModule(name) {
    var exports;
    var entry = defined[name];

    if (!entry) {
      exports = load(name);
      if (!exports)
        throw new Error("Unable to load dependency " + name + ".");
    }

    else {
      if (entry.declarative)
        ensureEvaluated(name, []);

      else if (!entry.evaluated)
        linkDynamicModule(entry);

      exports = entry.module.exports;
    }

    if ((!entry || entry.declarative) && exports && exports.__useDefault)
      return exports['default'];

    return exports;
  }

  function linkDynamicModule(entry) {
    if (entry.module)
      return;

    var exports = {};

    var module = entry.module = { exports: exports, id: entry.name };

    // AMD requires execute the tree first
    if (!entry.executingRequire) {
      for (var i = 0, l = entry.normalizedDeps.length; i < l; i++) {
        var depName = entry.normalizedDeps[i];
        var depEntry = defined[depName];
        if (depEntry)
          linkDynamicModule(depEntry);
      }
    }

    // now execute
    entry.evaluated = true;
    var output = entry.execute.call(global, function(name) {
      for (var i = 0, l = entry.deps.length; i < l; i++) {
        if (entry.deps[i] != name)
          continue;
        return getModule(entry.normalizedDeps[i]);
      }
      throw new TypeError('Module ' + name + ' not declared as a dependency.');
    }, exports, module);

    if (output)
      module.exports = output;

    // create the esModule object, which allows ES6 named imports of dynamics
    exports = module.exports;
 
    if (exports && exports.__esModule) {
      entry.esModule = exports;
    }
    else {
      entry.esModule = {};
      
      // don't trigger getters/setters in environments that support them
      if ((typeof exports == 'object' || typeof exports == 'function') && exports !== global) {
        if (getOwnPropertyDescriptor) {
          var d;
          for (var p in exports)
            if (d = Object.getOwnPropertyDescriptor(exports, p))
              defineProperty(entry.esModule, p, d);
        }
        else {
          var hasOwnProperty = exports && exports.hasOwnProperty;
          for (var p in exports) {
            if (!hasOwnProperty || exports.hasOwnProperty(p))
              entry.esModule[p] = exports[p];
          }
         }
       }
      entry.esModule['default'] = exports;
      defineProperty(entry.esModule, '__useDefault', {
        value: true
      });
    }
  }

  /*
   * Given a module, and the list of modules for this current branch,
   *  ensure that each of the dependencies of this module is evaluated
   *  (unless one is a circular dependency already in the list of seen
   *  modules, in which case we execute it)
   *
   * Then we evaluate the module itself depth-first left to right 
   * execution to match ES6 modules
   */
  function ensureEvaluated(moduleName, seen) {
    var entry = defined[moduleName];

    // if already seen, that means it's an already-evaluated non circular dependency
    if (!entry || entry.evaluated || !entry.declarative)
      return;

    // this only applies to declarative modules which late-execute

    seen.push(moduleName);

    for (var i = 0, l = entry.normalizedDeps.length; i < l; i++) {
      var depName = entry.normalizedDeps[i];
      if (indexOf.call(seen, depName) == -1) {
        if (!defined[depName])
          load(depName);
        else
          ensureEvaluated(depName, seen);
      }
    }

    if (entry.evaluated)
      return;

    entry.evaluated = true;
    entry.module.execute.call(global);
  }

  // magical execution function
  var modules = {};
  function load(name) {
    if (modules[name])
      return modules[name];

    // node core modules
    if (name.substr(0, 6) == '@node/')
      return require(name.substr(6));

    var entry = defined[name];

    // first we check if this module has already been defined in the registry
    if (!entry)
      throw "Module " + name + " not present.";

    // recursively ensure that the module and all its 
    // dependencies are linked (with dependency group handling)
    link(name);

    // now handle dependency execution in correct order
    ensureEvaluated(name, []);

    // remove from the registry
    defined[name] = undefined;

    // exported modules get __esModule defined for interop
    if (entry.declarative)
      defineProperty(entry.module.exports, '__esModule', { value: true });

    // return the defined module object
    return modules[name] = entry.declarative ? entry.module.exports : entry.esModule;
  };

  return function(mains, depNames, declare) {
    return function(formatDetect) {
      formatDetect(function(deps) {
        var System = {
          _nodeRequire: typeof require != 'undefined' && require.resolve && typeof process != 'undefined' && require,
          register: register,
          registerDynamic: registerDynamic,
          get: load, 
          set: function(name, module) {
            modules[name] = module; 
          },
          newModule: function(module) {
            return module;
          }
        };
        System.set('@empty', {});

        // register external dependencies
        for (var i = 0; i < depNames.length; i++) (function(depName, dep) {
          if (dep && dep.__esModule)
            System.register(depName, [], function(_export) {
              return {
                setters: [],
                execute: function() {
                  for (var p in dep)
                    if (p != '__esModule' && !(typeof p == 'object' && p + '' == 'Module'))
                      _export(p, dep[p]);
                }
              };
            });
          else
            System.registerDynamic(depName, [], false, function() {
              return dep;
            });
        })(depNames[i], arguments[i]);

        // register modules in this bundle
        declare(System);

        // load mains
        var firstLoad = load(mains[0]);
        if (mains.length > 1)
          for (var i = 1; i < mains.length; i++)
            load(mains[i]);

        if (firstLoad.__useDefault)
          return firstLoad['default'];
        else
          return firstLoad;
      });
    };
  };

})(typeof self != 'undefined' ? self : global)
/* (['mainModule'], ['external-dep'], function($__System) {
  System.register(...);
})
(function(factory) {
  if (typeof define && define.amd)
    define(['external-dep'], factory);
  // etc UMD / module pattern
})*/

(["1"], [], function($__System) {

(function() {
  var loader = $__System;
  
  if (typeof window != 'undefined' && typeof document != 'undefined' && window.location)
    var windowOrigin = location.protocol + '//' + location.hostname + (location.port ? ':' + location.port : '');

  loader.set('@@cjs-helpers', loader.newModule({
    getPathVars: function(moduleId) {
      // remove any plugin syntax
      var pluginIndex = moduleId.lastIndexOf('!');
      var filename;
      if (pluginIndex != -1)
        filename = moduleId.substr(0, pluginIndex);
      else
        filename = moduleId;

      var dirname = filename.split('/');
      dirname.pop();
      dirname = dirname.join('/');

      if (filename.substr(0, 8) == 'file:///') {
        filename = filename.substr(7);
        dirname = dirname.substr(7);

        // on windows remove leading '/'
        if (isWindows) {
          filename = filename.substr(1);
          dirname = dirname.substr(1);
        }
      }
      else if (windowOrigin && filename.substr(0, windowOrigin.length) === windowOrigin) {
        filename = filename.substr(windowOrigin.length);
        dirname = dirname.substr(windowOrigin.length);
      }

      return {
        filename: filename,
        dirname: dirname
      };
    }
  }));
})();

$__System.registerDynamic("2", ["3", "4", "5", "6"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var fromArray_1 = $__require('3');
  var combineLatest_support_1 = $__require('4');
  var isScheduler_1 = $__require('5');
  var isArray_1 = $__require('6');
  function combineLatest() {
    var observables = [];
    for (var _i = 0; _i < arguments.length; _i++) {
      observables[_i - 0] = arguments[_i];
    }
    var project = null;
    var scheduler = null;
    if (isScheduler_1.isScheduler(observables[observables.length - 1])) {
      scheduler = observables.pop();
    }
    if (typeof observables[observables.length - 1] === 'function') {
      project = observables.pop();
    }
    if (observables.length === 1 && isArray_1.isArray(observables[0])) {
      observables = observables[0];
    }
    return new fromArray_1.ArrayObservable(observables, scheduler).lift(new combineLatest_support_1.CombineLatestOperator(project));
  }
  exports.combineLatest = combineLatest;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("7", ["8", "2"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var combineLatest_static_1 = $__require('2');
  Observable_1.Observable.combineLatest = combineLatest_static_1.combineLatest;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("9", ["8", "a"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var concat_static_1 = $__require('a');
  Observable_1.Observable.concat = concat_static_1.concat;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("b", ["8", "c"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var merge_static_1 = $__require('c');
  Observable_1.Observable.merge = merge_static_1.merge;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("d", ["8", "e", "f", "10"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var __extends = (this && this.__extends) || function(d, b) {
    for (var p in b)
      if (b.hasOwnProperty(p))
        d[p] = b[p];
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
  var Observable_1 = $__require('8');
  var tryCatch_1 = $__require('e');
  var errorObject_1 = $__require('f');
  var AsyncSubject_1 = $__require('10');
  var BoundCallbackObservable = (function(_super) {
    __extends(BoundCallbackObservable, _super);
    function BoundCallbackObservable(callbackFunc, selector, args, scheduler) {
      _super.call(this);
      this.callbackFunc = callbackFunc;
      this.selector = selector;
      this.args = args;
      this.scheduler = scheduler;
    }
    BoundCallbackObservable.create = function(callbackFunc, selector, scheduler) {
      if (selector === void 0) {
        selector = undefined;
      }
      return function() {
        var args = [];
        for (var _i = 0; _i < arguments.length; _i++) {
          args[_i - 0] = arguments[_i];
        }
        return new BoundCallbackObservable(callbackFunc, selector, args, scheduler);
      };
    };
    BoundCallbackObservable.prototype._subscribe = function(subscriber) {
      var callbackFunc = this.callbackFunc;
      var args = this.args;
      var scheduler = this.scheduler;
      var subject = this.subject;
      if (!scheduler) {
        if (!subject) {
          subject = this.subject = new AsyncSubject_1.AsyncSubject();
          var handler = function handlerFn() {
            var innerArgs = [];
            for (var _i = 0; _i < arguments.length; _i++) {
              innerArgs[_i - 0] = arguments[_i];
            }
            var source = handlerFn.source;
            var selector = source.selector,
                subject = source.subject;
            if (selector) {
              var result_1 = tryCatch_1.tryCatch(selector).apply(this, innerArgs);
              if (result_1 === errorObject_1.errorObject) {
                subject.error(errorObject_1.errorObject.e);
              } else {
                subject.next(result_1);
                subject.complete();
              }
            } else {
              subject.next(innerArgs.length === 1 ? innerArgs[0] : innerArgs);
              subject.complete();
            }
          };
          handler.source = this;
          var result = tryCatch_1.tryCatch(callbackFunc).apply(this, args.concat(handler));
          if (result === errorObject_1.errorObject) {
            subject.error(errorObject_1.errorObject.e);
          }
        }
        return subject.subscribe(subscriber);
      } else {
        subscriber.add(scheduler.schedule(dispatch, 0, {
          source: this,
          subscriber: subscriber
        }));
        return subscriber;
      }
    };
    return BoundCallbackObservable;
  })(Observable_1.Observable);
  exports.BoundCallbackObservable = BoundCallbackObservable;
  function dispatch(state) {
    var source = state.source,
        subscriber = state.subscriber;
    var callbackFunc = source.callbackFunc,
        args = source.args,
        scheduler = source.scheduler;
    var subject = source.subject;
    if (!subject) {
      subject = source.subject = new AsyncSubject_1.AsyncSubject();
      var handler = function handlerFn() {
        var innerArgs = [];
        for (var _i = 0; _i < arguments.length; _i++) {
          innerArgs[_i - 0] = arguments[_i];
        }
        var source = handlerFn.source;
        var selector = source.selector,
            subject = source.subject;
        if (selector) {
          var result_2 = tryCatch_1.tryCatch(selector).apply(this, innerArgs);
          if (result_2 === errorObject_1.errorObject) {
            subject.add(scheduler.schedule(dispatchError, 0, {
              err: errorObject_1.errorObject.e,
              subject: subject
            }));
          } else {
            subject.add(scheduler.schedule(dispatchNext, 0, {
              value: result_2,
              subject: subject
            }));
          }
        } else {
          var value = innerArgs.length === 1 ? innerArgs[0] : innerArgs;
          subject.add(scheduler.schedule(dispatchNext, 0, {
            value: value,
            subject: subject
          }));
        }
      };
      handler.source = source;
      var result = tryCatch_1.tryCatch(callbackFunc).apply(this, args.concat(handler));
      if (result === errorObject_1.errorObject) {
        subject.error(errorObject_1.errorObject.e);
      }
    }
    this.add(subject.subscribe(subscriber));
  }
  function dispatchNext(_a) {
    var value = _a.value,
        subject = _a.subject;
    subject.next(value);
    subject.complete();
  }
  function dispatchError(_a) {
    var err = _a.err,
        subject = _a.subject;
    subject.error(err);
  }
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("11", ["8", "d"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var bindCallback_1 = $__require('d');
  Observable_1.Observable.bindCallback = bindCallback_1.BoundCallbackObservable.create;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("12", ["8", "e", "f"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var __extends = (this && this.__extends) || function(d, b) {
    for (var p in b)
      if (b.hasOwnProperty(p))
        d[p] = b[p];
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
  var Observable_1 = $__require('8');
  var tryCatch_1 = $__require('e');
  var errorObject_1 = $__require('f');
  var DeferObservable = (function(_super) {
    __extends(DeferObservable, _super);
    function DeferObservable(observableFactory) {
      _super.call(this);
      this.observableFactory = observableFactory;
    }
    DeferObservable.create = function(observableFactory) {
      return new DeferObservable(observableFactory);
    };
    DeferObservable.prototype._subscribe = function(subscriber) {
      var result = tryCatch_1.tryCatch(this.observableFactory)();
      if (result === errorObject_1.errorObject) {
        subscriber.error(errorObject_1.errorObject.e);
      } else {
        result.subscribe(subscriber);
      }
    };
    return DeferObservable;
  })(Observable_1.Observable);
  exports.DeferObservable = DeferObservable;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("13", ["8", "12"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var defer_1 = $__require('12');
  Observable_1.Observable.defer = defer_1.DeferObservable.create;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("14", ["8", "15"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var empty_1 = $__require('15');
  Observable_1.Observable.empty = empty_1.EmptyObservable.create;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("16", ["8", "17", "18", "15", "19", "6"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var __extends = (this && this.__extends) || function(d, b) {
    for (var p in b)
      if (b.hasOwnProperty(p))
        d[p] = b[p];
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
  var Observable_1 = $__require('8');
  var Subscriber_1 = $__require('17');
  var fromPromise_1 = $__require('18');
  var empty_1 = $__require('15');
  var isPromise_1 = $__require('19');
  var isArray_1 = $__require('6');
  var ForkJoinObservable = (function(_super) {
    __extends(ForkJoinObservable, _super);
    function ForkJoinObservable(sources, resultSelector) {
      _super.call(this);
      this.sources = sources;
      this.resultSelector = resultSelector;
    }
    ForkJoinObservable.create = function() {
      var sources = [];
      for (var _i = 0; _i < arguments.length; _i++) {
        sources[_i - 0] = arguments[_i];
      }
      if (sources === null || arguments.length === 0) {
        return new empty_1.EmptyObservable();
      }
      var resultSelector = null;
      if (typeof sources[sources.length - 1] === 'function') {
        resultSelector = sources.pop();
      }
      if (sources.length === 1 && isArray_1.isArray(sources[0])) {
        sources = sources[0];
      }
      return new ForkJoinObservable(sources, resultSelector);
    };
    ForkJoinObservable.prototype._subscribe = function(subscriber) {
      var sources = this.sources;
      var len = sources.length;
      var context = {
        completed: 0,
        total: len,
        values: emptyArray(len),
        selector: this.resultSelector
      };
      for (var i = 0; i < len; i++) {
        var source = sources[i];
        if (isPromise_1.isPromise(source)) {
          source = new fromPromise_1.PromiseObservable(source);
        }
        source.subscribe(new AllSubscriber(subscriber, i, context));
      }
    };
    return ForkJoinObservable;
  })(Observable_1.Observable);
  exports.ForkJoinObservable = ForkJoinObservable;
  var AllSubscriber = (function(_super) {
    __extends(AllSubscriber, _super);
    function AllSubscriber(destination, index, context) {
      _super.call(this, destination);
      this.index = index;
      this.context = context;
      this._value = null;
    }
    AllSubscriber.prototype._next = function(value) {
      this._value = value;
    };
    AllSubscriber.prototype._complete = function() {
      var destination = this.destination;
      if (this._value == null) {
        destination.complete();
      }
      var context = this.context;
      context.completed++;
      context.values[this.index] = this._value;
      var values = context.values;
      if (context.completed !== values.length) {
        return;
      }
      if (values.every(hasValue)) {
        var value = context.selector ? context.selector.apply(this, values) : values;
        destination.next(value);
      }
      destination.complete();
    };
    return AllSubscriber;
  })(Subscriber_1.Subscriber);
  function hasValue(x) {
    return x !== null;
  }
  function emptyArray(len) {
    var arr = [];
    for (var i = 0; i < len; i++) {
      arr.push(null);
    }
    return arr;
  }
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("1a", ["8", "16"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var forkJoin_1 = $__require('16');
  Observable_1.Observable.forkJoin = forkJoin_1.ForkJoinObservable.create;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("1b", ["8", "1c", "1d", "e", "f"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var __extends = (this && this.__extends) || function(d, b) {
    for (var p in b)
      if (b.hasOwnProperty(p))
        d[p] = b[p];
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
  var Observable_1 = $__require('8');
  var root_1 = $__require('1c');
  var SymbolShim_1 = $__require('1d');
  var tryCatch_1 = $__require('e');
  var errorObject_1 = $__require('f');
  var IteratorObservable = (function(_super) {
    __extends(IteratorObservable, _super);
    function IteratorObservable(iterator, project, thisArg, scheduler) {
      _super.call(this);
      this.project = project;
      this.thisArg = thisArg;
      this.scheduler = scheduler;
      if (iterator == null) {
        throw new Error('iterator cannot be null.');
      }
      if (project && typeof project !== 'function') {
        throw new Error('When provided, `project` must be a function.');
      }
      this.iterator = getIterator(iterator);
    }
    IteratorObservable.create = function(iterator, project, thisArg, scheduler) {
      return new IteratorObservable(iterator, project, thisArg, scheduler);
    };
    IteratorObservable.dispatch = function(state) {
      var index = state.index,
          hasError = state.hasError,
          thisArg = state.thisArg,
          project = state.project,
          iterator = state.iterator,
          subscriber = state.subscriber;
      if (hasError) {
        subscriber.error(state.error);
        return;
      }
      var result = iterator.next();
      if (result.done) {
        subscriber.complete();
        return;
      }
      if (project) {
        result = tryCatch_1.tryCatch(project).call(thisArg, result.value, index);
        if (result === errorObject_1.errorObject) {
          state.error = errorObject_1.errorObject.e;
          state.hasError = true;
        } else {
          subscriber.next(result);
          state.index = index + 1;
        }
      } else {
        subscriber.next(result.value);
        state.index = index + 1;
      }
      if (subscriber.isUnsubscribed) {
        return;
      }
      this.schedule(state);
    };
    IteratorObservable.prototype._subscribe = function(subscriber) {
      var index = 0;
      var _a = this,
          iterator = _a.iterator,
          project = _a.project,
          thisArg = _a.thisArg,
          scheduler = _a.scheduler;
      if (scheduler) {
        subscriber.add(scheduler.schedule(IteratorObservable.dispatch, 0, {
          index: index,
          thisArg: thisArg,
          project: project,
          iterator: iterator,
          subscriber: subscriber
        }));
      } else {
        do {
          var result = iterator.next();
          if (result.done) {
            subscriber.complete();
            break;
          } else if (project) {
            result = tryCatch_1.tryCatch(project).call(thisArg, result.value, index++);
            if (result === errorObject_1.errorObject) {
              subscriber.error(errorObject_1.errorObject.e);
              break;
            }
            subscriber.next(result);
          } else {
            subscriber.next(result.value);
          }
          if (subscriber.isUnsubscribed) {
            break;
          }
        } while (true);
      }
    };
    return IteratorObservable;
  })(Observable_1.Observable);
  exports.IteratorObservable = IteratorObservable;
  var StringIterator = (function() {
    function StringIterator(str, idx, len) {
      if (idx === void 0) {
        idx = 0;
      }
      if (len === void 0) {
        len = str.length;
      }
      this.str = str;
      this.idx = idx;
      this.len = len;
    }
    StringIterator.prototype[SymbolShim_1.SymbolShim.iterator] = function() {
      return (this);
    };
    StringIterator.prototype.next = function() {
      return this.idx < this.len ? {
        done: false,
        value: this.str.charAt(this.idx++)
      } : {
        done: true,
        value: undefined
      };
    };
    return StringIterator;
  })();
  var ArrayIterator = (function() {
    function ArrayIterator(arr, idx, len) {
      if (idx === void 0) {
        idx = 0;
      }
      if (len === void 0) {
        len = toLength(arr);
      }
      this.arr = arr;
      this.idx = idx;
      this.len = len;
    }
    ArrayIterator.prototype[SymbolShim_1.SymbolShim.iterator] = function() {
      return this;
    };
    ArrayIterator.prototype.next = function() {
      return this.idx < this.len ? {
        done: false,
        value: this.arr[this.idx++]
      } : {
        done: true,
        value: undefined
      };
    };
    return ArrayIterator;
  })();
  function getIterator(obj) {
    var i = obj[SymbolShim_1.SymbolShim.iterator];
    if (!i && typeof obj === 'string') {
      return new StringIterator(obj);
    }
    if (!i && obj.length !== undefined) {
      return new ArrayIterator(obj);
    }
    if (!i) {
      throw new TypeError('Object is not iterable');
    }
    return obj[SymbolShim_1.SymbolShim.iterator]();
  }
  var maxSafeInteger = Math.pow(2, 53) - 1;
  function toLength(o) {
    var len = +o.length;
    if (isNaN(len)) {
      return 0;
    }
    if (len === 0 || !numberIsFinite(len)) {
      return len;
    }
    len = sign(len) * Math.floor(Math.abs(len));
    if (len <= 0) {
      return 0;
    }
    if (len > maxSafeInteger) {
      return maxSafeInteger;
    }
    return len;
  }
  function numberIsFinite(value) {
    return typeof value === 'number' && root_1.root.isFinite(value);
  }
  function sign(value) {
    var valueAsNumber = +value;
    if (valueAsNumber === 0) {
      return valueAsNumber;
    }
    if (isNaN(valueAsNumber)) {
      return valueAsNumber;
    }
    return valueAsNumber < 0 ? -1 : 1;
  }
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("1e", ["18", "1b", "3", "1d", "8", "1f", "20"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var __extends = (this && this.__extends) || function(d, b) {
    for (var p in b)
      if (b.hasOwnProperty(p))
        d[p] = b[p];
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
  var fromPromise_1 = $__require('18');
  var IteratorObservable_1 = $__require('1b');
  var fromArray_1 = $__require('3');
  var SymbolShim_1 = $__require('1d');
  var Observable_1 = $__require('8');
  var observeOn_support_1 = $__require('1f');
  var queue_1 = $__require('20');
  var isArray = Array.isArray;
  var FromObservable = (function(_super) {
    __extends(FromObservable, _super);
    function FromObservable(ish, scheduler) {
      _super.call(this, null);
      this.ish = ish;
      this.scheduler = scheduler;
    }
    FromObservable.create = function(ish, scheduler) {
      if (scheduler === void 0) {
        scheduler = queue_1.queue;
      }
      if (ish) {
        if (isArray(ish)) {
          return new fromArray_1.ArrayObservable(ish, scheduler);
        } else if (typeof ish.then === 'function') {
          return new fromPromise_1.PromiseObservable(ish, scheduler);
        } else if (typeof ish[SymbolShim_1.SymbolShim.observable] === 'function') {
          if (ish instanceof Observable_1.Observable) {
            return ish;
          }
          return new FromObservable(ish, scheduler);
        } else if (typeof ish[SymbolShim_1.SymbolShim.iterator] === 'function') {
          return new IteratorObservable_1.IteratorObservable(ish, null, null, scheduler);
        }
      }
      throw new TypeError((typeof ish) + ' is not observable');
    };
    FromObservable.prototype._subscribe = function(subscriber) {
      var ish = this.ish;
      var scheduler = this.scheduler;
      if (scheduler === queue_1.queue) {
        return ish[SymbolShim_1.SymbolShim.observable]().subscribe(subscriber);
      } else {
        return ish[SymbolShim_1.SymbolShim.observable]().subscribe(new observeOn_support_1.ObserveOnSubscriber(subscriber, scheduler, 0));
      }
    };
    return FromObservable;
  })(Observable_1.Observable);
  exports.FromObservable = FromObservable;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("21", ["8", "1e"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var from_1 = $__require('1e');
  Observable_1.Observable.from = from_1.FromObservable.create;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("22", ["8", "3"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var fromArray_1 = $__require('3');
  Observable_1.Observable.fromArray = fromArray_1.ArrayObservable.create;
  Observable_1.Observable.of = fromArray_1.ArrayObservable.of;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("23", ["8", "e", "f", "24"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var __extends = (this && this.__extends) || function(d, b) {
    for (var p in b)
      if (b.hasOwnProperty(p))
        d[p] = b[p];
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
  var Observable_1 = $__require('8');
  var tryCatch_1 = $__require('e');
  var errorObject_1 = $__require('f');
  var Subscription_1 = $__require('24');
  var FromEventObservable = (function(_super) {
    __extends(FromEventObservable, _super);
    function FromEventObservable(sourceObj, eventName, selector) {
      _super.call(this);
      this.sourceObj = sourceObj;
      this.eventName = eventName;
      this.selector = selector;
    }
    FromEventObservable.create = function(sourceObj, eventName, selector) {
      return new FromEventObservable(sourceObj, eventName, selector);
    };
    FromEventObservable.setupSubscription = function(sourceObj, eventName, handler, subscriber) {
      var unsubscribe;
      var tag = sourceObj.toString();
      if (tag === '[object NodeList]' || tag === '[object HTMLCollection]') {
        for (var i = 0,
            len = sourceObj.length; i < len; i++) {
          FromEventObservable.setupSubscription(sourceObj[i], eventName, handler, subscriber);
        }
      } else if (typeof sourceObj.addEventListener === 'function' && typeof sourceObj.removeEventListener === 'function') {
        sourceObj.addEventListener(eventName, handler);
        unsubscribe = function() {
          return sourceObj.removeEventListener(eventName, handler);
        };
      } else if (typeof sourceObj.on === 'function' && typeof sourceObj.off === 'function') {
        sourceObj.on(eventName, handler);
        unsubscribe = function() {
          return sourceObj.off(eventName, handler);
        };
      } else if (typeof sourceObj.addListener === 'function' && typeof sourceObj.removeListener === 'function') {
        sourceObj.addListener(eventName, handler);
        unsubscribe = function() {
          return sourceObj.removeListener(eventName, handler);
        };
      }
      subscriber.add(new Subscription_1.Subscription(unsubscribe));
    };
    FromEventObservable.prototype._subscribe = function(subscriber) {
      var sourceObj = this.sourceObj;
      var eventName = this.eventName;
      var selector = this.selector;
      var handler = selector ? function(e) {
        var result = tryCatch_1.tryCatch(selector)(e);
        if (result === errorObject_1.errorObject) {
          subscriber.error(result.e);
        } else {
          subscriber.next(result);
        }
      } : function(e) {
        return subscriber.next(e);
      };
      FromEventObservable.setupSubscription(sourceObj, eventName, handler, subscriber);
    };
    return FromEventObservable;
  })(Observable_1.Observable);
  exports.FromEventObservable = FromEventObservable;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("25", ["8", "23"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var fromEvent_1 = $__require('23');
  Observable_1.Observable.fromEvent = fromEvent_1.FromEventObservable.create;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("26", ["8", "24", "e", "f"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var __extends = (this && this.__extends) || function(d, b) {
    for (var p in b)
      if (b.hasOwnProperty(p))
        d[p] = b[p];
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
  var Observable_1 = $__require('8');
  var Subscription_1 = $__require('24');
  var tryCatch_1 = $__require('e');
  var errorObject_1 = $__require('f');
  var FromEventPatternObservable = (function(_super) {
    __extends(FromEventPatternObservable, _super);
    function FromEventPatternObservable(addHandler, removeHandler, selector) {
      _super.call(this);
      this.addHandler = addHandler;
      this.removeHandler = removeHandler;
      this.selector = selector;
    }
    FromEventPatternObservable.create = function(addHandler, removeHandler, selector) {
      return new FromEventPatternObservable(addHandler, removeHandler, selector);
    };
    FromEventPatternObservable.prototype._subscribe = function(subscriber) {
      var addHandler = this.addHandler;
      var removeHandler = this.removeHandler;
      var selector = this.selector;
      var handler = selector ? function(e) {
        var result = tryCatch_1.tryCatch(selector).apply(null, arguments);
        if (result === errorObject_1.errorObject) {
          subscriber.error(result.e);
        } else {
          subscriber.next(result);
        }
      } : function(e) {
        subscriber.next(e);
      };
      var result = tryCatch_1.tryCatch(addHandler)(handler);
      if (result === errorObject_1.errorObject) {
        subscriber.error(result.e);
      }
      subscriber.add(new Subscription_1.Subscription(function() {
        removeHandler(handler);
      }));
    };
    return FromEventPatternObservable;
  })(Observable_1.Observable);
  exports.FromEventPatternObservable = FromEventPatternObservable;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("27", ["8", "26"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var fromEventPattern_1 = $__require('26');
  Observable_1.Observable.fromEventPattern = fromEventPattern_1.FromEventPatternObservable.create;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("28", ["8", "18"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var fromPromise_1 = $__require('18');
  Observable_1.Observable.fromPromise = fromPromise_1.PromiseObservable.create;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("29", ["2a", "8", "2b"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var __extends = (this && this.__extends) || function(d, b) {
    for (var p in b)
      if (b.hasOwnProperty(p))
        d[p] = b[p];
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
  var isNumeric_1 = $__require('2a');
  var Observable_1 = $__require('8');
  var asap_1 = $__require('2b');
  var IntervalObservable = (function(_super) {
    __extends(IntervalObservable, _super);
    function IntervalObservable(period, scheduler) {
      if (period === void 0) {
        period = 0;
      }
      if (scheduler === void 0) {
        scheduler = asap_1.asap;
      }
      _super.call(this);
      this.period = period;
      this.scheduler = scheduler;
      if (!isNumeric_1.isNumeric(period) || period < 0) {
        this.period = 0;
      }
      if (!scheduler || typeof scheduler.schedule !== 'function') {
        this.scheduler = asap_1.asap;
      }
    }
    IntervalObservable.create = function(period, scheduler) {
      if (period === void 0) {
        period = 0;
      }
      if (scheduler === void 0) {
        scheduler = asap_1.asap;
      }
      return new IntervalObservable(period, scheduler);
    };
    IntervalObservable.dispatch = function(state) {
      var index = state.index,
          subscriber = state.subscriber,
          period = state.period;
      subscriber.next(index);
      if (subscriber.isUnsubscribed) {
        return;
      }
      state.index += 1;
      this.schedule(state, period);
    };
    IntervalObservable.prototype._subscribe = function(subscriber) {
      var index = 0;
      var period = this.period;
      var scheduler = this.scheduler;
      subscriber.add(scheduler.schedule(IntervalObservable.dispatch, period, {
        index: index,
        subscriber: subscriber,
        period: period
      }));
    };
    return IntervalObservable;
  })(Observable_1.Observable);
  exports.IntervalObservable = IntervalObservable;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("2c", ["8", "29"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var interval_1 = $__require('29');
  Observable_1.Observable.interval = interval_1.IntervalObservable.create;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("2d", ["8", "2e"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var __extends = (this && this.__extends) || function(d, b) {
    for (var p in b)
      if (b.hasOwnProperty(p))
        d[p] = b[p];
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
  var Observable_1 = $__require('8');
  var noop_1 = $__require('2e');
  var InfiniteObservable = (function(_super) {
    __extends(InfiniteObservable, _super);
    function InfiniteObservable() {
      _super.call(this);
    }
    InfiniteObservable.create = function() {
      return new InfiniteObservable();
    };
    InfiniteObservable.prototype._subscribe = function(subscriber) {
      noop_1.noop();
    };
    return InfiniteObservable;
  })(Observable_1.Observable);
  exports.InfiniteObservable = InfiniteObservable;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("2f", ["8", "2d"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var never_1 = $__require('2d');
  Observable_1.Observable.never = never_1.InfiniteObservable.create;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("30", ["8"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var __extends = (this && this.__extends) || function(d, b) {
    for (var p in b)
      if (b.hasOwnProperty(p))
        d[p] = b[p];
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
  var Observable_1 = $__require('8');
  var RangeObservable = (function(_super) {
    __extends(RangeObservable, _super);
    function RangeObservable(start, end, scheduler) {
      _super.call(this);
      this.start = start;
      this.end = end;
      this.scheduler = scheduler;
    }
    RangeObservable.create = function(start, end, scheduler) {
      if (start === void 0) {
        start = 0;
      }
      if (end === void 0) {
        end = 0;
      }
      return new RangeObservable(start, end, scheduler);
    };
    RangeObservable.dispatch = function(state) {
      var start = state.start,
          index = state.index,
          end = state.end,
          subscriber = state.subscriber;
      if (index >= end) {
        subscriber.complete();
        return;
      }
      subscriber.next(start);
      if (subscriber.isUnsubscribed) {
        return;
      }
      state.index = index + 1;
      state.start = start + 1;
      this.schedule(state);
    };
    RangeObservable.prototype._subscribe = function(subscriber) {
      var index = 0;
      var start = this.start;
      var end = this.end;
      var scheduler = this.scheduler;
      if (scheduler) {
        subscriber.add(scheduler.schedule(RangeObservable.dispatch, 0, {
          index: index,
          end: end,
          start: start,
          subscriber: subscriber
        }));
      } else {
        do {
          if (index++ >= end) {
            subscriber.complete();
            break;
          }
          subscriber.next(start++);
          if (subscriber.isUnsubscribed) {
            break;
          }
        } while (true);
      }
    };
    return RangeObservable;
  })(Observable_1.Observable);
  exports.RangeObservable = RangeObservable;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("31", ["8", "30"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var range_1 = $__require('30');
  Observable_1.Observable.range = range_1.RangeObservable.create;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("32", ["8", "33"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var throw_1 = $__require('33');
  Observable_1.Observable.throw = throw_1.ErrorObservable.create;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("34", ["2a", "8", "2b", "5", "35"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var __extends = (this && this.__extends) || function(d, b) {
    for (var p in b)
      if (b.hasOwnProperty(p))
        d[p] = b[p];
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
  var isNumeric_1 = $__require('2a');
  var Observable_1 = $__require('8');
  var asap_1 = $__require('2b');
  var isScheduler_1 = $__require('5');
  var isDate_1 = $__require('35');
  var TimerObservable = (function(_super) {
    __extends(TimerObservable, _super);
    function TimerObservable(dueTime, period, scheduler) {
      if (dueTime === void 0) {
        dueTime = 0;
      }
      _super.call(this);
      this.period = period;
      this.scheduler = scheduler;
      this.dueTime = 0;
      if (isNumeric_1.isNumeric(period)) {
        this._period = Number(period) < 1 && 1 || Number(period);
      } else if (isScheduler_1.isScheduler(period)) {
        scheduler = period;
      }
      if (!isScheduler_1.isScheduler(scheduler)) {
        scheduler = asap_1.asap;
      }
      this.scheduler = scheduler;
      var absoluteDueTime = isDate_1.isDate(dueTime);
      this.dueTime = absoluteDueTime ? (+dueTime - this.scheduler.now()) : dueTime;
    }
    TimerObservable.create = function(dueTime, period, scheduler) {
      if (dueTime === void 0) {
        dueTime = 0;
      }
      return new TimerObservable(dueTime, period, scheduler);
    };
    TimerObservable.dispatch = function(state) {
      var index = state.index,
          period = state.period,
          subscriber = state.subscriber;
      var action = this;
      subscriber.next(index);
      if (typeof period === 'undefined') {
        subscriber.complete();
        return;
      } else if (subscriber.isUnsubscribed) {
        return;
      }
      if (typeof action.delay === 'undefined') {
        action.add(action.scheduler.schedule(TimerObservable.dispatch, period, {
          index: index + 1,
          period: period,
          subscriber: subscriber
        }));
      } else {
        state.index = index + 1;
        action.schedule(state, period);
      }
    };
    TimerObservable.prototype._subscribe = function(subscriber) {
      var index = 0;
      var period = this._period;
      var dueTime = this.dueTime;
      var scheduler = this.scheduler;
      subscriber.add(scheduler.schedule(TimerObservable.dispatch, dueTime, {
        index: index,
        period: period,
        subscriber: subscriber
      }));
    };
    return TimerObservable;
  })(Observable_1.Observable);
  exports.TimerObservable = TimerObservable;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("36", ["8", "34"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var timer_1 = $__require('34');
  Observable_1.Observable.timer = timer_1.TimerObservable.create;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("37", ["8", "38"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var zip_static_1 = $__require('38');
  Observable_1.Observable.zip = zip_static_1.zip;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("39", ["17", "3a"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  (function(Buffer) {
    var __extends = (this && this.__extends) || function(d, b) {
      for (var p in b)
        if (b.hasOwnProperty(p))
          d[p] = b[p];
      function __() {
        this.constructor = d;
      }
      d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
    };
    var Subscriber_1 = $__require('17');
    function buffer(closingNotifier) {
      return this.lift(new BufferOperator(closingNotifier));
    }
    exports.buffer = buffer;
    var BufferOperator = (function() {
      function BufferOperator(closingNotifier) {
        this.closingNotifier = closingNotifier;
      }
      BufferOperator.prototype.call = function(subscriber) {
        return new BufferSubscriber(subscriber, this.closingNotifier);
      };
      return BufferOperator;
    })();
    var BufferSubscriber = (function(_super) {
      __extends(BufferSubscriber, _super);
      function BufferSubscriber(destination, closingNotifier) {
        _super.call(this, destination);
        this.buffer = [];
        this.notifierSubscriber = null;
        this.notifierSubscriber = new BufferClosingNotifierSubscriber(this);
        this.add(closingNotifier._subscribe(this.notifierSubscriber));
      }
      BufferSubscriber.prototype._next = function(value) {
        this.buffer.push(value);
      };
      BufferSubscriber.prototype._error = function(err) {
        this.destination.error(err);
      };
      BufferSubscriber.prototype._complete = function() {
        this.destination.complete();
      };
      BufferSubscriber.prototype.flushBuffer = function() {
        var buffer = this.buffer;
        this.buffer = [];
        this.destination.next(buffer);
        if (this.isUnsubscribed) {
          this.notifierSubscriber.unsubscribe();
        }
      };
      return BufferSubscriber;
    })(Subscriber_1.Subscriber);
    var BufferClosingNotifierSubscriber = (function(_super) {
      __extends(BufferClosingNotifierSubscriber, _super);
      function BufferClosingNotifierSubscriber(parent) {
        _super.call(this, null);
        this.parent = parent;
      }
      BufferClosingNotifierSubscriber.prototype._next = function(value) {
        this.parent.flushBuffer();
      };
      BufferClosingNotifierSubscriber.prototype._error = function(err) {
        this.parent.error(err);
      };
      BufferClosingNotifierSubscriber.prototype._complete = function() {
        this.parent.complete();
      };
      return BufferClosingNotifierSubscriber;
    })(Subscriber_1.Subscriber);
  })($__require('3a').Buffer);
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("3b", ["8", "39"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var buffer_1 = $__require('39');
  Observable_1.Observable.prototype.buffer = buffer_1.buffer;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("3c", ["17", "3a"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  (function(Buffer) {
    var __extends = (this && this.__extends) || function(d, b) {
      for (var p in b)
        if (b.hasOwnProperty(p))
          d[p] = b[p];
      function __() {
        this.constructor = d;
      }
      d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
    };
    var Subscriber_1 = $__require('17');
    function bufferCount(bufferSize, startBufferEvery) {
      if (startBufferEvery === void 0) {
        startBufferEvery = null;
      }
      return this.lift(new BufferCountOperator(bufferSize, startBufferEvery));
    }
    exports.bufferCount = bufferCount;
    var BufferCountOperator = (function() {
      function BufferCountOperator(bufferSize, startBufferEvery) {
        this.bufferSize = bufferSize;
        this.startBufferEvery = startBufferEvery;
      }
      BufferCountOperator.prototype.call = function(subscriber) {
        return new BufferCountSubscriber(subscriber, this.bufferSize, this.startBufferEvery);
      };
      return BufferCountOperator;
    })();
    var BufferCountSubscriber = (function(_super) {
      __extends(BufferCountSubscriber, _super);
      function BufferCountSubscriber(destination, bufferSize, startBufferEvery) {
        _super.call(this, destination);
        this.bufferSize = bufferSize;
        this.startBufferEvery = startBufferEvery;
        this.buffers = [[]];
        this.count = 0;
      }
      BufferCountSubscriber.prototype._next = function(value) {
        var count = (this.count += 1);
        var destination = this.destination;
        var bufferSize = this.bufferSize;
        var startBufferEvery = (this.startBufferEvery == null) ? bufferSize : this.startBufferEvery;
        var buffers = this.buffers;
        var len = buffers.length;
        var remove = -1;
        if (count % startBufferEvery === 0) {
          buffers.push([]);
        }
        for (var i = 0; i < len; i++) {
          var buffer = buffers[i];
          buffer.push(value);
          if (buffer.length === bufferSize) {
            remove = i;
            destination.next(buffer);
          }
        }
        if (remove !== -1) {
          buffers.splice(remove, 1);
        }
      };
      BufferCountSubscriber.prototype._error = function(err) {
        this.destination.error(err);
      };
      BufferCountSubscriber.prototype._complete = function() {
        var destination = this.destination;
        var buffers = this.buffers;
        while (buffers.length > 0) {
          var buffer = buffers.shift();
          if (buffer.length > 0) {
            destination.next(buffer);
          }
        }
        destination.complete();
      };
      return BufferCountSubscriber;
    })(Subscriber_1.Subscriber);
  })($__require('3a').Buffer);
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("3d", ["8", "3c"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var bufferCount_1 = $__require('3c');
  Observable_1.Observable.prototype.bufferCount = bufferCount_1.bufferCount;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("3e", ["17", "2b", "3a"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  (function(Buffer) {
    var __extends = (this && this.__extends) || function(d, b) {
      for (var p in b)
        if (b.hasOwnProperty(p))
          d[p] = b[p];
      function __() {
        this.constructor = d;
      }
      d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
    };
    var Subscriber_1 = $__require('17');
    var asap_1 = $__require('2b');
    function bufferTime(bufferTimeSpan, bufferCreationInterval, scheduler) {
      if (bufferCreationInterval === void 0) {
        bufferCreationInterval = null;
      }
      if (scheduler === void 0) {
        scheduler = asap_1.asap;
      }
      return this.lift(new BufferTimeOperator(bufferTimeSpan, bufferCreationInterval, scheduler));
    }
    exports.bufferTime = bufferTime;
    var BufferTimeOperator = (function() {
      function BufferTimeOperator(bufferTimeSpan, bufferCreationInterval, scheduler) {
        this.bufferTimeSpan = bufferTimeSpan;
        this.bufferCreationInterval = bufferCreationInterval;
        this.scheduler = scheduler;
      }
      BufferTimeOperator.prototype.call = function(subscriber) {
        return new BufferTimeSubscriber(subscriber, this.bufferTimeSpan, this.bufferCreationInterval, this.scheduler);
      };
      return BufferTimeOperator;
    })();
    var BufferTimeSubscriber = (function(_super) {
      __extends(BufferTimeSubscriber, _super);
      function BufferTimeSubscriber(destination, bufferTimeSpan, bufferCreationInterval, scheduler) {
        _super.call(this, destination);
        this.bufferTimeSpan = bufferTimeSpan;
        this.bufferCreationInterval = bufferCreationInterval;
        this.scheduler = scheduler;
        this.buffers = [];
        var buffer = this.openBuffer();
        if (bufferCreationInterval !== null && bufferCreationInterval >= 0) {
          var closeState = {
            subscriber: this,
            buffer: buffer
          };
          var creationState = {
            bufferTimeSpan: bufferTimeSpan,
            bufferCreationInterval: bufferCreationInterval,
            subscriber: this,
            scheduler: scheduler
          };
          this.add(scheduler.schedule(dispatchBufferClose, bufferTimeSpan, closeState));
          this.add(scheduler.schedule(dispatchBufferCreation, bufferCreationInterval, creationState));
        } else {
          var timeSpanOnlyState = {
            subscriber: this,
            buffer: buffer,
            bufferTimeSpan: bufferTimeSpan
          };
          this.add(scheduler.schedule(dispatchBufferTimeSpanOnly, bufferTimeSpan, timeSpanOnlyState));
        }
      }
      BufferTimeSubscriber.prototype._next = function(value) {
        var buffers = this.buffers;
        var len = buffers.length;
        for (var i = 0; i < len; i++) {
          buffers[i].push(value);
        }
      };
      BufferTimeSubscriber.prototype._error = function(err) {
        this.buffers.length = 0;
        this.destination.error(err);
      };
      BufferTimeSubscriber.prototype._complete = function() {
        var buffers = this.buffers;
        while (buffers.length > 0) {
          this.destination.next(buffers.shift());
        }
        this.destination.complete();
      };
      BufferTimeSubscriber.prototype.openBuffer = function() {
        var buffer = [];
        this.buffers.push(buffer);
        return buffer;
      };
      BufferTimeSubscriber.prototype.closeBuffer = function(buffer) {
        this.destination.next(buffer);
        var buffers = this.buffers;
        buffers.splice(buffers.indexOf(buffer), 1);
      };
      return BufferTimeSubscriber;
    })(Subscriber_1.Subscriber);
    function dispatchBufferTimeSpanOnly(state) {
      var subscriber = state.subscriber;
      var prevBuffer = state.buffer;
      if (prevBuffer) {
        subscriber.closeBuffer(prevBuffer);
      }
      state.buffer = subscriber.openBuffer();
      if (!subscriber.isUnsubscribed) {
        this.schedule(state, state.bufferTimeSpan);
      }
    }
    function dispatchBufferCreation(state) {
      var bufferCreationInterval = state.bufferCreationInterval,
          bufferTimeSpan = state.bufferTimeSpan,
          subscriber = state.subscriber,
          scheduler = state.scheduler;
      var buffer = subscriber.openBuffer();
      var action = this;
      if (!subscriber.isUnsubscribed) {
        action.add(scheduler.schedule(dispatchBufferClose, bufferTimeSpan, {
          subscriber: subscriber,
          buffer: buffer
        }));
        action.schedule(state, bufferCreationInterval);
      }
    }
    function dispatchBufferClose(_a) {
      var subscriber = _a.subscriber,
          buffer = _a.buffer;
      subscriber.closeBuffer(buffer);
    }
  })($__require('3a').Buffer);
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("3f", ["8", "3e"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var bufferTime_1 = $__require('3e');
  Observable_1.Observable.prototype.bufferTime = bufferTime_1.bufferTime;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("40", ["17", "24", "e", "f", "3a"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  (function(Buffer) {
    var __extends = (this && this.__extends) || function(d, b) {
      for (var p in b)
        if (b.hasOwnProperty(p))
          d[p] = b[p];
      function __() {
        this.constructor = d;
      }
      d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
    };
    var Subscriber_1 = $__require('17');
    var Subscription_1 = $__require('24');
    var tryCatch_1 = $__require('e');
    var errorObject_1 = $__require('f');
    function bufferToggle(openings, closingSelector) {
      return this.lift(new BufferToggleOperator(openings, closingSelector));
    }
    exports.bufferToggle = bufferToggle;
    var BufferToggleOperator = (function() {
      function BufferToggleOperator(openings, closingSelector) {
        this.openings = openings;
        this.closingSelector = closingSelector;
      }
      BufferToggleOperator.prototype.call = function(subscriber) {
        return new BufferToggleSubscriber(subscriber, this.openings, this.closingSelector);
      };
      return BufferToggleOperator;
    })();
    var BufferToggleSubscriber = (function(_super) {
      __extends(BufferToggleSubscriber, _super);
      function BufferToggleSubscriber(destination, openings, closingSelector) {
        _super.call(this, destination);
        this.openings = openings;
        this.closingSelector = closingSelector;
        this.contexts = [];
        this.add(this.openings._subscribe(new BufferToggleOpeningsSubscriber(this)));
      }
      BufferToggleSubscriber.prototype._next = function(value) {
        var contexts = this.contexts;
        var len = contexts.length;
        for (var i = 0; i < len; i++) {
          contexts[i].buffer.push(value);
        }
      };
      BufferToggleSubscriber.prototype._error = function(err) {
        var contexts = this.contexts;
        while (contexts.length > 0) {
          var context = contexts.shift();
          context.subscription.unsubscribe();
          context.buffer = null;
          context.subscription = null;
        }
        this.contexts = null;
        this.destination.error(err);
      };
      BufferToggleSubscriber.prototype._complete = function() {
        var contexts = this.contexts;
        while (contexts.length > 0) {
          var context = contexts.shift();
          this.destination.next(context.buffer);
          context.subscription.unsubscribe();
          context.buffer = null;
          context.subscription = null;
        }
        this.contexts = null;
        this.destination.complete();
      };
      BufferToggleSubscriber.prototype.openBuffer = function(value) {
        var closingSelector = this.closingSelector;
        var contexts = this.contexts;
        var closingNotifier = tryCatch_1.tryCatch(closingSelector)(value);
        if (closingNotifier === errorObject_1.errorObject) {
          this._error(closingNotifier.e);
        } else {
          var context = {
            buffer: [],
            subscription: new Subscription_1.Subscription()
          };
          contexts.push(context);
          var subscriber = new BufferToggleClosingsSubscriber(this, context);
          var subscription = closingNotifier._subscribe(subscriber);
          context.subscription.add(subscription);
          this.add(subscription);
        }
      };
      BufferToggleSubscriber.prototype.closeBuffer = function(context) {
        var contexts = this.contexts;
        if (contexts === null) {
          return;
        }
        var buffer = context.buffer,
            subscription = context.subscription;
        this.destination.next(buffer);
        contexts.splice(contexts.indexOf(context), 1);
        this.remove(subscription);
        subscription.unsubscribe();
      };
      return BufferToggleSubscriber;
    })(Subscriber_1.Subscriber);
    var BufferToggleOpeningsSubscriber = (function(_super) {
      __extends(BufferToggleOpeningsSubscriber, _super);
      function BufferToggleOpeningsSubscriber(parent) {
        _super.call(this, null);
        this.parent = parent;
      }
      BufferToggleOpeningsSubscriber.prototype._next = function(value) {
        this.parent.openBuffer(value);
      };
      BufferToggleOpeningsSubscriber.prototype._error = function(err) {
        this.parent.error(err);
      };
      BufferToggleOpeningsSubscriber.prototype._complete = function() {};
      return BufferToggleOpeningsSubscriber;
    })(Subscriber_1.Subscriber);
    var BufferToggleClosingsSubscriber = (function(_super) {
      __extends(BufferToggleClosingsSubscriber, _super);
      function BufferToggleClosingsSubscriber(parent, context) {
        _super.call(this, null);
        this.parent = parent;
        this.context = context;
      }
      BufferToggleClosingsSubscriber.prototype._next = function() {
        this.parent.closeBuffer(this.context);
      };
      BufferToggleClosingsSubscriber.prototype._error = function(err) {
        this.parent.error(err);
      };
      BufferToggleClosingsSubscriber.prototype._complete = function() {
        this.parent.closeBuffer(this.context);
      };
      return BufferToggleClosingsSubscriber;
    })(Subscriber_1.Subscriber);
  })($__require('3a').Buffer);
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("41", ["8", "40"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var bufferToggle_1 = $__require('40');
  Observable_1.Observable.prototype.bufferToggle = bufferToggle_1.bufferToggle;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("42", ["17", "e", "f", "3a", "43"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  (function(Buffer, process) {
    var __extends = (this && this.__extends) || function(d, b) {
      for (var p in b)
        if (b.hasOwnProperty(p))
          d[p] = b[p];
      function __() {
        this.constructor = d;
      }
      d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
    };
    var Subscriber_1 = $__require('17');
    var tryCatch_1 = $__require('e');
    var errorObject_1 = $__require('f');
    function bufferWhen(closingSelector) {
      return this.lift(new BufferWhenOperator(closingSelector));
    }
    exports.bufferWhen = bufferWhen;
    var BufferWhenOperator = (function() {
      function BufferWhenOperator(closingSelector) {
        this.closingSelector = closingSelector;
      }
      BufferWhenOperator.prototype.call = function(subscriber) {
        return new BufferWhenSubscriber(subscriber, this.closingSelector);
      };
      return BufferWhenOperator;
    })();
    var BufferWhenSubscriber = (function(_super) {
      __extends(BufferWhenSubscriber, _super);
      function BufferWhenSubscriber(destination, closingSelector) {
        _super.call(this, destination);
        this.closingSelector = closingSelector;
        this.openBuffer();
      }
      BufferWhenSubscriber.prototype._next = function(value) {
        this.buffer.push(value);
      };
      BufferWhenSubscriber.prototype._error = function(err) {
        this.buffer = null;
        this.destination.error(err);
      };
      BufferWhenSubscriber.prototype._complete = function() {
        var buffer = this.buffer;
        this.destination.next(buffer);
        this.buffer = null;
        this.destination.complete();
      };
      BufferWhenSubscriber.prototype.openBuffer = function() {
        var prevClosingNotification = this.closingNotification;
        if (prevClosingNotification) {
          this.remove(prevClosingNotification);
          prevClosingNotification.unsubscribe();
        }
        var buffer = this.buffer;
        if (buffer) {
          this.destination.next(buffer);
        }
        this.buffer = [];
        var closingNotifier = tryCatch_1.tryCatch(this.closingSelector)();
        if (closingNotifier === errorObject_1.errorObject) {
          var err = closingNotifier.e;
          this.buffer = null;
          this.destination.error(err);
        } else {
          this.add(this.closingNotification = closingNotifier._subscribe(new BufferClosingNotifierSubscriber(this)));
        }
      };
      return BufferWhenSubscriber;
    })(Subscriber_1.Subscriber);
    var BufferClosingNotifierSubscriber = (function(_super) {
      __extends(BufferClosingNotifierSubscriber, _super);
      function BufferClosingNotifierSubscriber(parent) {
        _super.call(this, null);
        this.parent = parent;
      }
      BufferClosingNotifierSubscriber.prototype._next = function() {
        this.parent.openBuffer();
      };
      BufferClosingNotifierSubscriber.prototype._error = function(err) {
        this.parent.error(err);
      };
      BufferClosingNotifierSubscriber.prototype._complete = function() {
        this.parent.openBuffer();
      };
      return BufferClosingNotifierSubscriber;
    })(Subscriber_1.Subscriber);
  })($__require('3a').Buffer, $__require('43'));
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("44", ["8", "42"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var bufferWhen_1 = $__require('42');
  Observable_1.Observable.prototype.bufferWhen = bufferWhen_1.bufferWhen;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("45", ["17", "e", "f"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var __extends = (this && this.__extends) || function(d, b) {
    for (var p in b)
      if (b.hasOwnProperty(p))
        d[p] = b[p];
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
  var Subscriber_1 = $__require('17');
  var tryCatch_1 = $__require('e');
  var errorObject_1 = $__require('f');
  function _catch(selector) {
    var catchOperator = new CatchOperator(selector);
    var caught = this.lift(catchOperator);
    catchOperator.caught = caught;
    return caught;
  }
  exports._catch = _catch;
  var CatchOperator = (function() {
    function CatchOperator(selector) {
      this.selector = selector;
    }
    CatchOperator.prototype.call = function(subscriber) {
      return new CatchSubscriber(subscriber, this.selector, this.caught);
    };
    return CatchOperator;
  })();
  var CatchSubscriber = (function(_super) {
    __extends(CatchSubscriber, _super);
    function CatchSubscriber(destination, selector, caught) {
      _super.call(this, null);
      this.destination = destination;
      this.selector = selector;
      this.caught = caught;
      this.lastSubscription = this;
      this.destination.add(this);
    }
    CatchSubscriber.prototype._next = function(value) {
      this.destination.next(value);
    };
    CatchSubscriber.prototype._error = function(err) {
      var result = tryCatch_1.tryCatch(this.selector)(err, this.caught);
      if (result === errorObject_1.errorObject) {
        this.destination.error(errorObject_1.errorObject.e);
      } else {
        this.lastSubscription.unsubscribe();
        this.lastSubscription = result.subscribe(this.destination);
      }
    };
    CatchSubscriber.prototype._complete = function() {
      this.lastSubscription.unsubscribe();
      this.destination.complete();
    };
    CatchSubscriber.prototype._unsubscribe = function() {
      this.lastSubscription.unsubscribe();
    };
    return CatchSubscriber;
  })(Subscriber_1.Subscriber);
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("46", ["8", "45"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var catch_1 = $__require('45');
  Observable_1.Observable.prototype.catch = catch_1._catch;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("47", ["4"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var combineLatest_support_1 = $__require('4');
  function combineAll(project) {
    return this.lift(new combineLatest_support_1.CombineLatestOperator(project));
  }
  exports.combineAll = combineAll;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("48", ["8", "47"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var combineAll_1 = $__require('47');
  Observable_1.Observable.prototype.combineAll = combineAll_1.combineAll;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("4", ["e", "f", "49", "4a"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var __extends = (this && this.__extends) || function(d, b) {
    for (var p in b)
      if (b.hasOwnProperty(p))
        d[p] = b[p];
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
  var tryCatch_1 = $__require('e');
  var errorObject_1 = $__require('f');
  var OuterSubscriber_1 = $__require('49');
  var subscribeToResult_1 = $__require('4a');
  var CombineLatestOperator = (function() {
    function CombineLatestOperator(project) {
      this.project = project;
    }
    CombineLatestOperator.prototype.call = function(subscriber) {
      return new CombineLatestSubscriber(subscriber, this.project);
    };
    return CombineLatestOperator;
  })();
  exports.CombineLatestOperator = CombineLatestOperator;
  var CombineLatestSubscriber = (function(_super) {
    __extends(CombineLatestSubscriber, _super);
    function CombineLatestSubscriber(destination, project) {
      _super.call(this, destination);
      this.project = project;
      this.active = 0;
      this.values = [];
      this.observables = [];
      this.toRespond = [];
    }
    CombineLatestSubscriber.prototype._next = function(observable) {
      var toRespond = this.toRespond;
      toRespond.push(toRespond.length);
      this.observables.push(observable);
    };
    CombineLatestSubscriber.prototype._complete = function() {
      var observables = this.observables;
      var len = observables.length;
      if (len === 0) {
        this.destination.complete();
      } else {
        this.active = len;
        for (var i = 0; i < len; i++) {
          var observable = observables[i];
          this.add(subscribeToResult_1.subscribeToResult(this, observable, observable, i));
        }
      }
    };
    CombineLatestSubscriber.prototype.notifyComplete = function(unused) {
      if ((this.active -= 1) === 0) {
        this.destination.complete();
      }
    };
    CombineLatestSubscriber.prototype.notifyNext = function(observable, value, outerIndex, innerIndex) {
      var values = this.values;
      values[outerIndex] = value;
      var toRespond = this.toRespond;
      if (toRespond.length > 0) {
        var found = toRespond.indexOf(outerIndex);
        if (found !== -1) {
          toRespond.splice(found, 1);
        }
      }
      if (toRespond.length === 0) {
        var project = this.project;
        var destination = this.destination;
        if (project) {
          var result = tryCatch_1.tryCatch(project).apply(this, values);
          if (result === errorObject_1.errorObject) {
            destination.error(errorObject_1.errorObject.e);
          } else {
            destination.next(result);
          }
        } else {
          destination.next(values);
        }
      }
    };
    return CombineLatestSubscriber;
  })(OuterSubscriber_1.OuterSubscriber);
  exports.CombineLatestSubscriber = CombineLatestSubscriber;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("6", [], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  exports.isArray = Array.isArray || (function(x) {
    return x && typeof x.length === 'number';
  });
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("4b", ["3", "4", "6"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var fromArray_1 = $__require('3');
  var combineLatest_support_1 = $__require('4');
  var isArray_1 = $__require('6');
  function combineLatest() {
    var observables = [];
    for (var _i = 0; _i < arguments.length; _i++) {
      observables[_i - 0] = arguments[_i];
    }
    var project = null;
    if (typeof observables[observables.length - 1] === 'function') {
      project = observables.pop();
    }
    if (observables.length === 1 && isArray_1.isArray(observables[0])) {
      observables = observables[0];
    }
    observables.unshift(this);
    return new fromArray_1.ArrayObservable(observables).lift(new combineLatest_support_1.CombineLatestOperator(project));
  }
  exports.combineLatest = combineLatest;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("4c", ["8", "4b"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var combineLatest_1 = $__require('4b');
  Observable_1.Observable.prototype.combineLatest = combineLatest_1.combineLatest;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("4d", ["5", "3", "4e"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var isScheduler_1 = $__require('5');
  var fromArray_1 = $__require('3');
  var mergeAll_support_1 = $__require('4e');
  function concat() {
    var observables = [];
    for (var _i = 0; _i < arguments.length; _i++) {
      observables[_i - 0] = arguments[_i];
    }
    var args = observables;
    args.unshift(this);
    var scheduler = null;
    if (isScheduler_1.isScheduler(args[args.length - 1])) {
      scheduler = args.pop();
    }
    return new fromArray_1.ArrayObservable(args, scheduler).lift(new mergeAll_support_1.MergeAllOperator(1));
  }
  exports.concat = concat;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("4f", ["8", "4d"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var concat_1 = $__require('4d');
  Observable_1.Observable.prototype.concat = concat_1.concat;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("50", ["4e"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var mergeAll_support_1 = $__require('4e');
  function concatAll() {
    return this.lift(new mergeAll_support_1.MergeAllOperator(1));
  }
  exports.concatAll = concatAll;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("51", ["8", "50"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var concatAll_1 = $__require('50');
  Observable_1.Observable.prototype.concatAll = concatAll_1.concatAll;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("52", ["53"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var mergeMap_support_1 = $__require('53');
  function concatMap(project, projectResult) {
    return this.lift(new mergeMap_support_1.MergeMapOperator(project, projectResult, 1));
  }
  exports.concatMap = concatMap;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("54", ["8", "52"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var concatMap_1 = $__require('52');
  Observable_1.Observable.prototype.concatMap = concatMap_1.concatMap;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("55", ["56"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var mergeMapTo_support_1 = $__require('56');
  function concatMapTo(observable, projectResult) {
    return this.lift(new mergeMapTo_support_1.MergeMapToOperator(observable, projectResult, 1));
  }
  exports.concatMapTo = concatMapTo;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("57", ["8", "55"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var concatMapTo_1 = $__require('55');
  Observable_1.Observable.prototype.concatMapTo = concatMapTo_1.concatMapTo;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("58", ["17", "e", "f"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var __extends = (this && this.__extends) || function(d, b) {
    for (var p in b)
      if (b.hasOwnProperty(p))
        d[p] = b[p];
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
  var Subscriber_1 = $__require('17');
  var tryCatch_1 = $__require('e');
  var errorObject_1 = $__require('f');
  function count(predicate) {
    return this.lift(new CountOperator(predicate, this));
  }
  exports.count = count;
  var CountOperator = (function() {
    function CountOperator(predicate, source) {
      this.predicate = predicate;
      this.source = source;
    }
    CountOperator.prototype.call = function(subscriber) {
      return new CountSubscriber(subscriber, this.predicate, this.source);
    };
    return CountOperator;
  })();
  var CountSubscriber = (function(_super) {
    __extends(CountSubscriber, _super);
    function CountSubscriber(destination, predicate, source) {
      _super.call(this, destination);
      this.predicate = predicate;
      this.source = source;
      this.count = 0;
      this.index = 0;
    }
    CountSubscriber.prototype._next = function(value) {
      var predicate = this.predicate;
      var passed = true;
      if (predicate) {
        passed = tryCatch_1.tryCatch(predicate)(value, this.index++, this.source);
        if (passed === errorObject_1.errorObject) {
          this.destination.error(passed.e);
          return;
        }
      }
      if (passed) {
        this.count += 1;
      }
    };
    CountSubscriber.prototype._complete = function() {
      this.destination.next(this.count);
      this.destination.complete();
    };
    return CountSubscriber;
  })(Subscriber_1.Subscriber);
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("59", ["8", "58"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var count_1 = $__require('58');
  Observable_1.Observable.prototype.count = count_1.count;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("5a", ["17"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var __extends = (this && this.__extends) || function(d, b) {
    for (var p in b)
      if (b.hasOwnProperty(p))
        d[p] = b[p];
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
  var Subscriber_1 = $__require('17');
  function dematerialize() {
    return this.lift(new DeMaterializeOperator());
  }
  exports.dematerialize = dematerialize;
  var DeMaterializeOperator = (function() {
    function DeMaterializeOperator() {}
    DeMaterializeOperator.prototype.call = function(subscriber) {
      return new DeMaterializeSubscriber(subscriber);
    };
    return DeMaterializeOperator;
  })();
  var DeMaterializeSubscriber = (function(_super) {
    __extends(DeMaterializeSubscriber, _super);
    function DeMaterializeSubscriber(destination) {
      _super.call(this, destination);
    }
    DeMaterializeSubscriber.prototype._next = function(value) {
      value.observe(this.destination);
    };
    return DeMaterializeSubscriber;
  })(Subscriber_1.Subscriber);
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("5b", ["8", "5a"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var dematerialize_1 = $__require('5a');
  Observable_1.Observable.prototype.dematerialize = dematerialize_1.dematerialize;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("5c", ["18", "17", "e", "19", "f"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var __extends = (this && this.__extends) || function(d, b) {
    for (var p in b)
      if (b.hasOwnProperty(p))
        d[p] = b[p];
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
  var fromPromise_1 = $__require('18');
  var Subscriber_1 = $__require('17');
  var tryCatch_1 = $__require('e');
  var isPromise_1 = $__require('19');
  var errorObject_1 = $__require('f');
  function debounce(durationSelector) {
    return this.lift(new DebounceOperator(durationSelector));
  }
  exports.debounce = debounce;
  var DebounceOperator = (function() {
    function DebounceOperator(durationSelector) {
      this.durationSelector = durationSelector;
    }
    DebounceOperator.prototype.call = function(observer) {
      return new DebounceSubscriber(observer, this.durationSelector);
    };
    return DebounceOperator;
  })();
  var DebounceSubscriber = (function(_super) {
    __extends(DebounceSubscriber, _super);
    function DebounceSubscriber(destination, durationSelector) {
      _super.call(this, destination);
      this.durationSelector = durationSelector;
      this.debouncedSubscription = null;
      this.lastValue = null;
      this._index = 0;
    }
    Object.defineProperty(DebounceSubscriber.prototype, "index", {
      get: function() {
        return this._index;
      },
      enumerable: true,
      configurable: true
    });
    DebounceSubscriber.prototype._next = function(value) {
      var destination = this.destination;
      var currentIndex = ++this._index;
      var debounce = tryCatch_1.tryCatch(this.durationSelector)(value);
      if (debounce === errorObject_1.errorObject) {
        destination.error(errorObject_1.errorObject.e);
      } else {
        if (isPromise_1.isPromise(debounce)) {
          debounce = fromPromise_1.PromiseObservable.create(debounce);
        }
        this.lastValue = value;
        this.clearDebounce();
        this.add(this.debouncedSubscription = debounce._subscribe(new DurationSelectorSubscriber(this, currentIndex)));
      }
    };
    DebounceSubscriber.prototype._complete = function() {
      this.debouncedNext();
      this.destination.complete();
    };
    DebounceSubscriber.prototype.debouncedNext = function() {
      this.clearDebounce();
      if (this.lastValue != null) {
        this.destination.next(this.lastValue);
        this.lastValue = null;
      }
    };
    DebounceSubscriber.prototype.clearDebounce = function() {
      var debouncedSubscription = this.debouncedSubscription;
      if (debouncedSubscription) {
        debouncedSubscription.unsubscribe();
        this.remove(debouncedSubscription);
        this.debouncedSubscription = null;
      }
    };
    return DebounceSubscriber;
  })(Subscriber_1.Subscriber);
  var DurationSelectorSubscriber = (function(_super) {
    __extends(DurationSelectorSubscriber, _super);
    function DurationSelectorSubscriber(parent, currentIndex) {
      _super.call(this, null);
      this.parent = parent;
      this.currentIndex = currentIndex;
    }
    DurationSelectorSubscriber.prototype.debounceNext = function() {
      var parent = this.parent;
      if (this.currentIndex === parent.index) {
        parent.debouncedNext();
        if (!this.isUnsubscribed) {
          this.unsubscribe();
        }
      }
    };
    DurationSelectorSubscriber.prototype._next = function(unused) {
      this.debounceNext();
    };
    DurationSelectorSubscriber.prototype._error = function(err) {
      this.parent.error(err);
    };
    DurationSelectorSubscriber.prototype._complete = function() {
      this.debounceNext();
    };
    return DurationSelectorSubscriber;
  })(Subscriber_1.Subscriber);
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("5d", ["8", "5c"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var debounce_1 = $__require('5c');
  Observable_1.Observable.prototype.debounce = debounce_1.debounce;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("5e", ["17", "2b"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var __extends = (this && this.__extends) || function(d, b) {
    for (var p in b)
      if (b.hasOwnProperty(p))
        d[p] = b[p];
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
  var Subscriber_1 = $__require('17');
  var asap_1 = $__require('2b');
  function debounceTime(dueTime, scheduler) {
    if (scheduler === void 0) {
      scheduler = asap_1.asap;
    }
    return this.lift(new DebounceTimeOperator(dueTime, scheduler));
  }
  exports.debounceTime = debounceTime;
  var DebounceTimeOperator = (function() {
    function DebounceTimeOperator(dueTime, scheduler) {
      this.dueTime = dueTime;
      this.scheduler = scheduler;
    }
    DebounceTimeOperator.prototype.call = function(subscriber) {
      return new DebounceTimeSubscriber(subscriber, this.dueTime, this.scheduler);
    };
    return DebounceTimeOperator;
  })();
  var DebounceTimeSubscriber = (function(_super) {
    __extends(DebounceTimeSubscriber, _super);
    function DebounceTimeSubscriber(destination, dueTime, scheduler) {
      _super.call(this, destination);
      this.dueTime = dueTime;
      this.scheduler = scheduler;
      this.debouncedSubscription = null;
      this.lastValue = null;
    }
    DebounceTimeSubscriber.prototype._next = function(value) {
      this.clearDebounce();
      this.lastValue = value;
      this.add(this.debouncedSubscription = this.scheduler.schedule(dispatchNext, this.dueTime, this));
    };
    DebounceTimeSubscriber.prototype._complete = function() {
      this.debouncedNext();
      this.destination.complete();
    };
    DebounceTimeSubscriber.prototype.debouncedNext = function() {
      this.clearDebounce();
      if (this.lastValue != null) {
        this.destination.next(this.lastValue);
        this.lastValue = null;
      }
    };
    DebounceTimeSubscriber.prototype.clearDebounce = function() {
      var debouncedSubscription = this.debouncedSubscription;
      if (debouncedSubscription !== null) {
        this.remove(debouncedSubscription);
        debouncedSubscription.unsubscribe();
        this.debouncedSubscription = null;
      }
    };
    return DebounceTimeSubscriber;
  })(Subscriber_1.Subscriber);
  function dispatchNext(subscriber) {
    subscriber.debouncedNext();
  }
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("5f", ["8", "5e"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var debounceTime_1 = $__require('5e');
  Observable_1.Observable.prototype.debounceTime = debounceTime_1.debounceTime;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("60", ["17"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var __extends = (this && this.__extends) || function(d, b) {
    for (var p in b)
      if (b.hasOwnProperty(p))
        d[p] = b[p];
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
  var Subscriber_1 = $__require('17');
  function defaultIfEmpty(defaultValue) {
    if (defaultValue === void 0) {
      defaultValue = null;
    }
    return this.lift(new DefaultIfEmptyOperator(defaultValue));
  }
  exports.defaultIfEmpty = defaultIfEmpty;
  var DefaultIfEmptyOperator = (function() {
    function DefaultIfEmptyOperator(defaultValue) {
      this.defaultValue = defaultValue;
    }
    DefaultIfEmptyOperator.prototype.call = function(subscriber) {
      return new DefaultIfEmptySubscriber(subscriber, this.defaultValue);
    };
    return DefaultIfEmptyOperator;
  })();
  var DefaultIfEmptySubscriber = (function(_super) {
    __extends(DefaultIfEmptySubscriber, _super);
    function DefaultIfEmptySubscriber(destination, defaultValue) {
      _super.call(this, destination);
      this.defaultValue = defaultValue;
      this.isEmpty = true;
    }
    DefaultIfEmptySubscriber.prototype._next = function(value) {
      this.isEmpty = false;
      this.destination.next(value);
    };
    DefaultIfEmptySubscriber.prototype._complete = function() {
      if (this.isEmpty) {
        this.destination.next(this.defaultValue);
      }
      this.destination.complete();
    };
    return DefaultIfEmptySubscriber;
  })(Subscriber_1.Subscriber);
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("61", ["8", "60"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var defaultIfEmpty_1 = $__require('60');
  Observable_1.Observable.prototype.defaultIfEmpty = defaultIfEmpty_1.defaultIfEmpty;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("62", ["17", "63", "20", "35"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var __extends = (this && this.__extends) || function(d, b) {
    for (var p in b)
      if (b.hasOwnProperty(p))
        d[p] = b[p];
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
  var Subscriber_1 = $__require('17');
  var Notification_1 = $__require('63');
  var queue_1 = $__require('20');
  var isDate_1 = $__require('35');
  function delay(delay, scheduler) {
    if (scheduler === void 0) {
      scheduler = queue_1.queue;
    }
    var absoluteDelay = isDate_1.isDate(delay);
    var delayFor = absoluteDelay ? (+delay - scheduler.now()) : delay;
    return this.lift(new DelayOperator(delayFor, scheduler));
  }
  exports.delay = delay;
  var DelayOperator = (function() {
    function DelayOperator(delay, scheduler) {
      this.delay = delay;
      this.scheduler = scheduler;
    }
    DelayOperator.prototype.call = function(subscriber) {
      return new DelaySubscriber(subscriber, this.delay, this.scheduler);
    };
    return DelayOperator;
  })();
  var DelaySubscriber = (function(_super) {
    __extends(DelaySubscriber, _super);
    function DelaySubscriber(destination, delay, scheduler) {
      _super.call(this, destination);
      this.delay = delay;
      this.scheduler = scheduler;
      this.queue = [];
      this.active = false;
      this.errored = false;
    }
    DelaySubscriber.dispatch = function(state) {
      var source = state.source;
      var queue = source.queue;
      var scheduler = state.scheduler;
      var destination = state.destination;
      while (queue.length > 0 && (queue[0].time - scheduler.now()) <= 0) {
        queue.shift().notification.observe(destination);
      }
      if (queue.length > 0) {
        var delay_1 = Math.max(0, queue[0].time - scheduler.now());
        this.schedule(state, delay_1);
      } else {
        source.active = false;
      }
    };
    DelaySubscriber.prototype._schedule = function(scheduler) {
      this.active = true;
      this.add(scheduler.schedule(DelaySubscriber.dispatch, this.delay, {
        source: this,
        destination: this.destination,
        scheduler: scheduler
      }));
    };
    DelaySubscriber.prototype.scheduleNotification = function(notification) {
      if (this.errored === true) {
        return;
      }
      var scheduler = this.scheduler;
      var message = new DelayMessage(scheduler.now() + this.delay, notification);
      this.queue.push(message);
      if (this.active === false) {
        this._schedule(scheduler);
      }
    };
    DelaySubscriber.prototype._next = function(value) {
      this.scheduleNotification(Notification_1.Notification.createNext(value));
    };
    DelaySubscriber.prototype._error = function(err) {
      this.errored = true;
      this.queue = [];
      this.destination.error(err);
    };
    DelaySubscriber.prototype._complete = function() {
      this.scheduleNotification(Notification_1.Notification.createComplete());
    };
    return DelaySubscriber;
  })(Subscriber_1.Subscriber);
  var DelayMessage = (function() {
    function DelayMessage(time, notification) {
      this.time = time;
      this.notification = notification;
    }
    return DelayMessage;
  })();
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("64", ["8", "62"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var delay_1 = $__require('62');
  Observable_1.Observable.prototype.delay = delay_1.delay;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("65", ["17", "e", "f"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var __extends = (this && this.__extends) || function(d, b) {
    for (var p in b)
      if (b.hasOwnProperty(p))
        d[p] = b[p];
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
  var Subscriber_1 = $__require('17');
  var tryCatch_1 = $__require('e');
  var errorObject_1 = $__require('f');
  function distinctUntilChanged(compare) {
    return this.lift(new DistinctUntilChangedOperator(compare));
  }
  exports.distinctUntilChanged = distinctUntilChanged;
  var DistinctUntilChangedOperator = (function() {
    function DistinctUntilChangedOperator(compare) {
      this.compare = compare;
    }
    DistinctUntilChangedOperator.prototype.call = function(subscriber) {
      return new DistinctUntilChangedSubscriber(subscriber, this.compare);
    };
    return DistinctUntilChangedOperator;
  })();
  var DistinctUntilChangedSubscriber = (function(_super) {
    __extends(DistinctUntilChangedSubscriber, _super);
    function DistinctUntilChangedSubscriber(destination, compare) {
      _super.call(this, destination);
      this.hasValue = false;
      if (typeof compare === 'function') {
        this.compare = compare;
      }
    }
    DistinctUntilChangedSubscriber.prototype.compare = function(x, y) {
      return x === y;
    };
    DistinctUntilChangedSubscriber.prototype._next = function(value) {
      var result = false;
      if (this.hasValue) {
        result = tryCatch_1.tryCatch(this.compare)(this.value, value);
        if (result === errorObject_1.errorObject) {
          this.destination.error(errorObject_1.errorObject.e);
          return;
        }
      } else {
        this.hasValue = true;
      }
      if (Boolean(result) === false) {
        this.value = value;
        this.destination.next(value);
      }
    };
    return DistinctUntilChangedSubscriber;
  })(Subscriber_1.Subscriber);
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("66", ["8", "65"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var distinctUntilChanged_1 = $__require('65');
  Observable_1.Observable.prototype.distinctUntilChanged = distinctUntilChanged_1.distinctUntilChanged;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("67", ["17", "2e", "e", "f"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var __extends = (this && this.__extends) || function(d, b) {
    for (var p in b)
      if (b.hasOwnProperty(p))
        d[p] = b[p];
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
  var Subscriber_1 = $__require('17');
  var noop_1 = $__require('2e');
  var tryCatch_1 = $__require('e');
  var errorObject_1 = $__require('f');
  function _do(nextOrObserver, error, complete) {
    var next;
    if (nextOrObserver && typeof nextOrObserver === 'object') {
      next = nextOrObserver.next;
      error = nextOrObserver.error;
      complete = nextOrObserver.complete;
    } else {
      next = nextOrObserver;
    }
    return this.lift(new DoOperator(next || noop_1.noop, error || noop_1.noop, complete || noop_1.noop));
  }
  exports._do = _do;
  var DoOperator = (function() {
    function DoOperator(next, error, complete) {
      this.next = next;
      this.error = error;
      this.complete = complete;
    }
    DoOperator.prototype.call = function(subscriber) {
      return new DoSubscriber(subscriber, this.next, this.error, this.complete);
    };
    return DoOperator;
  })();
  var DoSubscriber = (function(_super) {
    __extends(DoSubscriber, _super);
    function DoSubscriber(destination, next, error, complete) {
      _super.call(this, destination);
      this.__next = next;
      this.__error = error;
      this.__complete = complete;
    }
    DoSubscriber.prototype._next = function(x) {
      var result = tryCatch_1.tryCatch(this.__next)(x);
      if (result === errorObject_1.errorObject) {
        this.destination.error(errorObject_1.errorObject.e);
      } else {
        this.destination.next(x);
      }
    };
    DoSubscriber.prototype._error = function(e) {
      var result = tryCatch_1.tryCatch(this.__error)(e);
      if (result === errorObject_1.errorObject) {
        this.destination.error(errorObject_1.errorObject.e);
      } else {
        this.destination.error(e);
      }
    };
    DoSubscriber.prototype._complete = function() {
      var result = tryCatch_1.tryCatch(this.__complete)();
      if (result === errorObject_1.errorObject) {
        this.destination.error(errorObject_1.errorObject.e);
      } else {
        this.destination.complete();
      }
    };
    return DoSubscriber;
  })(Subscriber_1.Subscriber);
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("68", ["8", "67"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var do_1 = $__require('67');
  Observable_1.Observable.prototype.do = do_1._do;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("69", ["e", "f", "49", "4a"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var __extends = (this && this.__extends) || function(d, b) {
    for (var p in b)
      if (b.hasOwnProperty(p))
        d[p] = b[p];
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
  var tryCatch_1 = $__require('e');
  var errorObject_1 = $__require('f');
  var OuterSubscriber_1 = $__require('49');
  var subscribeToResult_1 = $__require('4a');
  var ExpandOperator = (function() {
    function ExpandOperator(project, concurrent, scheduler) {
      this.project = project;
      this.concurrent = concurrent;
      this.scheduler = scheduler;
    }
    ExpandOperator.prototype.call = function(subscriber) {
      return new ExpandSubscriber(subscriber, this.project, this.concurrent, this.scheduler);
    };
    return ExpandOperator;
  })();
  exports.ExpandOperator = ExpandOperator;
  var ExpandSubscriber = (function(_super) {
    __extends(ExpandSubscriber, _super);
    function ExpandSubscriber(destination, project, concurrent, scheduler) {
      _super.call(this, destination);
      this.project = project;
      this.concurrent = concurrent;
      this.scheduler = scheduler;
      this.index = 0;
      this.active = 0;
      this.hasCompleted = false;
      if (concurrent < Number.POSITIVE_INFINITY) {
        this.buffer = [];
      }
    }
    ExpandSubscriber.dispatch = function(_a) {
      var subscriber = _a.subscriber,
          result = _a.result,
          value = _a.value,
          index = _a.index;
      subscriber.subscribeToProjection(result, value, index);
    };
    ExpandSubscriber.prototype._next = function(value) {
      var destination = this.destination;
      if (destination.isUnsubscribed) {
        this._complete();
        return;
      }
      var index = this.index++;
      if (this.active < this.concurrent) {
        destination.next(value);
        var result = tryCatch_1.tryCatch(this.project)(value, index);
        if (result === errorObject_1.errorObject) {
          destination.error(result.e);
        } else if (!this.scheduler) {
          this.subscribeToProjection(result, value, index);
        } else {
          var state = {
            subscriber: this,
            result: result,
            value: value,
            index: index
          };
          this.add(this.scheduler.schedule(ExpandSubscriber.dispatch, 0, state));
        }
      } else {
        this.buffer.push(value);
      }
    };
    ExpandSubscriber.prototype.subscribeToProjection = function(result, value, index) {
      if (result._isScalar) {
        this._next(result.value);
      } else {
        this.active++;
        this.add(subscribeToResult_1.subscribeToResult(this, result, value, index));
      }
    };
    ExpandSubscriber.prototype._complete = function() {
      this.hasCompleted = true;
      if (this.hasCompleted && this.active === 0) {
        this.destination.complete();
      }
    };
    ExpandSubscriber.prototype.notifyComplete = function(innerSub) {
      var buffer = this.buffer;
      this.remove(innerSub);
      this.active--;
      if (buffer && buffer.length > 0) {
        this._next(buffer.shift());
      }
      if (this.hasCompleted && this.active === 0) {
        this.destination.complete();
      }
    };
    ExpandSubscriber.prototype.notifyNext = function(outerValue, innerValue, outerIndex, innerIndex) {
      this._next(innerValue);
    };
    return ExpandSubscriber;
  })(OuterSubscriber_1.OuterSubscriber);
  exports.ExpandSubscriber = ExpandSubscriber;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("6a", ["69"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var expand_support_1 = $__require('69');
  function expand(project, concurrent, scheduler) {
    if (concurrent === void 0) {
      concurrent = Number.POSITIVE_INFINITY;
    }
    if (scheduler === void 0) {
      scheduler = undefined;
    }
    concurrent = (concurrent || 0) < 1 ? Number.POSITIVE_INFINITY : concurrent;
    return this.lift(new expand_support_1.ExpandOperator(project, concurrent, scheduler));
  }
  exports.expand = expand;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("6b", ["8", "6a"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var expand_1 = $__require('6a');
  Observable_1.Observable.prototype.expand = expand_1.expand;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("6c", ["8", "6d"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var filter_1 = $__require('6d');
  Observable_1.Observable.prototype.filter = filter_1.filter;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("6e", ["17", "24"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var __extends = (this && this.__extends) || function(d, b) {
    for (var p in b)
      if (b.hasOwnProperty(p))
        d[p] = b[p];
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
  var Subscriber_1 = $__require('17');
  var Subscription_1 = $__require('24');
  function _finally(finallySelector) {
    return this.lift(new FinallyOperator(finallySelector));
  }
  exports._finally = _finally;
  var FinallyOperator = (function() {
    function FinallyOperator(finallySelector) {
      this.finallySelector = finallySelector;
    }
    FinallyOperator.prototype.call = function(subscriber) {
      return new FinallySubscriber(subscriber, this.finallySelector);
    };
    return FinallyOperator;
  })();
  var FinallySubscriber = (function(_super) {
    __extends(FinallySubscriber, _super);
    function FinallySubscriber(destination, finallySelector) {
      _super.call(this, destination);
      this.add(new Subscription_1.Subscription(finallySelector));
    }
    return FinallySubscriber;
  })(Subscriber_1.Subscriber);
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("6f", ["8", "6e"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var finally_1 = $__require('6e');
  Observable_1.Observable.prototype.finally = finally_1._finally;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("70", ["17", "e", "f", "71"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var __extends = (this && this.__extends) || function(d, b) {
    for (var p in b)
      if (b.hasOwnProperty(p))
        d[p] = b[p];
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
  var Subscriber_1 = $__require('17');
  var tryCatch_1 = $__require('e');
  var errorObject_1 = $__require('f');
  var EmptyError_1 = $__require('71');
  function first(predicate, resultSelector, defaultValue) {
    return this.lift(new FirstOperator(predicate, resultSelector, defaultValue, this));
  }
  exports.first = first;
  var FirstOperator = (function() {
    function FirstOperator(predicate, resultSelector, defaultValue, source) {
      this.predicate = predicate;
      this.resultSelector = resultSelector;
      this.defaultValue = defaultValue;
      this.source = source;
    }
    FirstOperator.prototype.call = function(observer) {
      return new FirstSubscriber(observer, this.predicate, this.resultSelector, this.defaultValue, this.source);
    };
    return FirstOperator;
  })();
  var FirstSubscriber = (function(_super) {
    __extends(FirstSubscriber, _super);
    function FirstSubscriber(destination, predicate, resultSelector, defaultValue, source) {
      _super.call(this, destination);
      this.predicate = predicate;
      this.resultSelector = resultSelector;
      this.defaultValue = defaultValue;
      this.source = source;
      this.index = 0;
      this.hasCompleted = false;
    }
    FirstSubscriber.prototype._next = function(value) {
      var _a = this,
          destination = _a.destination,
          predicate = _a.predicate,
          resultSelector = _a.resultSelector;
      var index = this.index++;
      var passed = true;
      if (predicate) {
        passed = tryCatch_1.tryCatch(predicate)(value, index, this.source);
        if (passed === errorObject_1.errorObject) {
          destination.error(errorObject_1.errorObject.e);
          return;
        }
      }
      if (passed) {
        if (resultSelector) {
          var result = tryCatch_1.tryCatch(resultSelector)(value, index);
          if (result === errorObject_1.errorObject) {
            destination.error(errorObject_1.errorObject.e);
            return;
          }
          destination.next(result);
        } else {
          destination.next(value);
        }
        destination.complete();
        this.hasCompleted = true;
      }
    };
    FirstSubscriber.prototype._complete = function() {
      var destination = this.destination;
      if (!this.hasCompleted && typeof this.defaultValue !== 'undefined') {
        destination.next(this.defaultValue);
        destination.complete();
      } else if (!this.hasCompleted) {
        destination.error(new EmptyError_1.EmptyError);
      }
    };
    return FirstSubscriber;
  })(Subscriber_1.Subscriber);
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("72", ["8", "70"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var first_1 = $__require('70');
  Observable_1.Observable.prototype.first = first_1.first;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("73", [], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var MapPolyfill = (function() {
    function MapPolyfill() {
      this.size = 0;
      this._values = [];
      this._keys = [];
    }
    MapPolyfill.prototype.get = function(key) {
      var i = this._keys.indexOf(key);
      return i === -1 ? undefined : this._values[i];
    };
    MapPolyfill.prototype.set = function(key, value) {
      var i = this._keys.indexOf(key);
      if (i === -1) {
        this._keys.push(key);
        this._values.push(value);
        this.size++;
      } else {
        this._values[i] = value;
      }
      return this;
    };
    MapPolyfill.prototype.delete = function(key) {
      var i = this._keys.indexOf(key);
      if (i === -1) {
        return false;
      }
      this._values.splice(i, 1);
      this._keys.splice(i, 1);
      this.size--;
      return true;
    };
    MapPolyfill.prototype.forEach = function(cb, thisArg) {
      for (var i = 0; i < this.size; i++) {
        cb.call(thisArg, this._values[i], this._keys[i]);
      }
    };
    return MapPolyfill;
  })();
  exports.MapPolyfill = MapPolyfill;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("74", ["1c", "73"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var root_1 = $__require('1c');
  var MapPolyfill_1 = $__require('73');
  exports.Map = root_1.root.Map || (function() {
    return MapPolyfill_1.MapPolyfill;
  })();
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("75", [], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var FastMap = (function() {
    function FastMap() {
      this.values = {};
    }
    FastMap.prototype.delete = function(key) {
      this.values[key] = null;
      return true;
    };
    FastMap.prototype.set = function(key, value) {
      this.values[key] = value;
      return this;
    };
    FastMap.prototype.get = function(key) {
      return this.values[key];
    };
    FastMap.prototype.forEach = function(cb, thisArg) {
      var values = this.values;
      for (var key in values) {
        if (values.hasOwnProperty(key) && values[key] !== null) {
          cb.call(thisArg, values[key], key);
        }
      }
    };
    FastMap.prototype.clear = function() {
      this.values = {};
    };
    return FastMap;
  })();
  exports.FastMap = FastMap;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("76", ["24", "8"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var __extends = (this && this.__extends) || function(d, b) {
    for (var p in b)
      if (b.hasOwnProperty(p))
        d[p] = b[p];
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
  var Subscription_1 = $__require('24');
  var Observable_1 = $__require('8');
  var RefCountSubscription = (function(_super) {
    __extends(RefCountSubscription, _super);
    function RefCountSubscription() {
      _super.call(this);
      this.attemptedToUnsubscribePrimary = false;
      this.count = 0;
    }
    RefCountSubscription.prototype.setPrimary = function(subscription) {
      this.primary = subscription;
    };
    RefCountSubscription.prototype.unsubscribe = function() {
      if (!this.isUnsubscribed && !this.attemptedToUnsubscribePrimary) {
        this.attemptedToUnsubscribePrimary = true;
        if (this.count === 0) {
          _super.prototype.unsubscribe.call(this);
          this.primary.unsubscribe();
        }
      }
    };
    return RefCountSubscription;
  })(Subscription_1.Subscription);
  exports.RefCountSubscription = RefCountSubscription;
  var GroupedObservable = (function(_super) {
    __extends(GroupedObservable, _super);
    function GroupedObservable(key, groupSubject, refCountSubscription) {
      _super.call(this);
      this.key = key;
      this.groupSubject = groupSubject;
      this.refCountSubscription = refCountSubscription;
    }
    GroupedObservable.prototype._subscribe = function(subscriber) {
      var subscription = new Subscription_1.Subscription();
      if (this.refCountSubscription && !this.refCountSubscription.isUnsubscribed) {
        subscription.add(new InnerRefCountSubscription(this.refCountSubscription));
      }
      subscription.add(this.groupSubject.subscribe(subscriber));
      return subscription;
    };
    return GroupedObservable;
  })(Observable_1.Observable);
  exports.GroupedObservable = GroupedObservable;
  var InnerRefCountSubscription = (function(_super) {
    __extends(InnerRefCountSubscription, _super);
    function InnerRefCountSubscription(parent) {
      _super.call(this);
      this.parent = parent;
      parent.count++;
    }
    InnerRefCountSubscription.prototype.unsubscribe = function() {
      if (!this.parent.isUnsubscribed && !this.isUnsubscribed) {
        _super.prototype.unsubscribe.call(this);
        this.parent.count--;
        if (this.parent.count === 0 && this.parent.attemptedToUnsubscribePrimary) {
          this.parent.unsubscribe();
          this.parent.primary.unsubscribe();
        }
      }
    };
    return InnerRefCountSubscription;
  })(Subscription_1.Subscription);
  exports.InnerRefCountSubscription = InnerRefCountSubscription;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("77", ["17", "8", "78", "74", "75", "76", "e", "f"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var __extends = (this && this.__extends) || function(d, b) {
    for (var p in b)
      if (b.hasOwnProperty(p))
        d[p] = b[p];
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
  var Subscriber_1 = $__require('17');
  var Observable_1 = $__require('8');
  var Subject_1 = $__require('78');
  var Map_1 = $__require('74');
  var FastMap_1 = $__require('75');
  var groupBy_support_1 = $__require('76');
  var tryCatch_1 = $__require('e');
  var errorObject_1 = $__require('f');
  function groupBy(keySelector, elementSelector, durationSelector) {
    return new GroupByObservable(this, keySelector, elementSelector, durationSelector);
  }
  exports.groupBy = groupBy;
  var GroupByObservable = (function(_super) {
    __extends(GroupByObservable, _super);
    function GroupByObservable(source, keySelector, elementSelector, durationSelector) {
      _super.call(this);
      this.source = source;
      this.keySelector = keySelector;
      this.elementSelector = elementSelector;
      this.durationSelector = durationSelector;
    }
    GroupByObservable.prototype._subscribe = function(subscriber) {
      var refCountSubscription = new groupBy_support_1.RefCountSubscription();
      var groupBySubscriber = new GroupBySubscriber(subscriber, refCountSubscription, this.keySelector, this.elementSelector, this.durationSelector);
      refCountSubscription.setPrimary(this.source.subscribe(groupBySubscriber));
      return refCountSubscription;
    };
    return GroupByObservable;
  })(Observable_1.Observable);
  exports.GroupByObservable = GroupByObservable;
  var GroupBySubscriber = (function(_super) {
    __extends(GroupBySubscriber, _super);
    function GroupBySubscriber(destination, refCountSubscription, keySelector, elementSelector, durationSelector) {
      _super.call(this);
      this.refCountSubscription = refCountSubscription;
      this.keySelector = keySelector;
      this.elementSelector = elementSelector;
      this.durationSelector = durationSelector;
      this.groups = null;
      this.destination = destination;
      this.add(destination);
    }
    GroupBySubscriber.prototype._next = function(x) {
      var key = tryCatch_1.tryCatch(this.keySelector)(x);
      if (key === errorObject_1.errorObject) {
        this.error(key.e);
      } else {
        var groups = this.groups;
        var elementSelector = this.elementSelector;
        var durationSelector = this.durationSelector;
        if (!groups) {
          groups = this.groups = typeof key === 'string' ? new FastMap_1.FastMap() : new Map_1.Map();
        }
        var group = groups.get(key);
        if (!group) {
          groups.set(key, group = new Subject_1.Subject());
          var groupedObservable = new groupBy_support_1.GroupedObservable(key, group, this.refCountSubscription);
          if (durationSelector) {
            var duration = tryCatch_1.tryCatch(durationSelector)(new groupBy_support_1.GroupedObservable(key, group));
            if (duration === errorObject_1.errorObject) {
              this.error(duration.e);
            } else {
              this.add(duration._subscribe(new GroupDurationSubscriber(key, group, this)));
            }
          }
          this.destination.next(groupedObservable);
        }
        if (elementSelector) {
          var value = tryCatch_1.tryCatch(elementSelector)(x);
          if (value === errorObject_1.errorObject) {
            this.error(value.e);
          } else {
            group.next(value);
          }
        } else {
          group.next(x);
        }
      }
    };
    GroupBySubscriber.prototype._error = function(err) {
      var _this = this;
      var groups = this.groups;
      if (groups) {
        groups.forEach(function(group, key) {
          group.error(err);
          _this.removeGroup(key);
        });
      }
      this.destination.error(err);
    };
    GroupBySubscriber.prototype._complete = function() {
      var _this = this;
      var groups = this.groups;
      if (groups) {
        groups.forEach(function(group, key) {
          group.complete();
          _this.removeGroup(group);
        });
      }
      this.destination.complete();
    };
    GroupBySubscriber.prototype.removeGroup = function(key) {
      this.groups.delete(key);
    };
    return GroupBySubscriber;
  })(Subscriber_1.Subscriber);
  var GroupDurationSubscriber = (function(_super) {
    __extends(GroupDurationSubscriber, _super);
    function GroupDurationSubscriber(key, group, parent) {
      _super.call(this, null);
      this.key = key;
      this.group = group;
      this.parent = parent;
    }
    GroupDurationSubscriber.prototype._next = function(value) {
      this.group.complete();
      this.parent.removeGroup(this.key);
    };
    GroupDurationSubscriber.prototype._error = function(err) {
      this.group.error(err);
      this.parent.removeGroup(this.key);
    };
    GroupDurationSubscriber.prototype._complete = function() {
      this.group.complete();
      this.parent.removeGroup(this.key);
    };
    return GroupDurationSubscriber;
  })(Subscriber_1.Subscriber);
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("79", ["8", "77"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var groupBy_1 = $__require('77');
  Observable_1.Observable.prototype.groupBy = groupBy_1.groupBy;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("7a", ["17", "2e"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var __extends = (this && this.__extends) || function(d, b) {
    for (var p in b)
      if (b.hasOwnProperty(p))
        d[p] = b[p];
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
  var Subscriber_1 = $__require('17');
  var noop_1 = $__require('2e');
  function ignoreElements() {
    return this.lift(new IgnoreElementsOperator());
  }
  exports.ignoreElements = ignoreElements;
  ;
  var IgnoreElementsOperator = (function() {
    function IgnoreElementsOperator() {}
    IgnoreElementsOperator.prototype.call = function(subscriber) {
      return new IgnoreElementsSubscriber(subscriber);
    };
    return IgnoreElementsOperator;
  })();
  var IgnoreElementsSubscriber = (function(_super) {
    __extends(IgnoreElementsSubscriber, _super);
    function IgnoreElementsSubscriber() {
      _super.apply(this, arguments);
    }
    IgnoreElementsSubscriber.prototype._next = function(unused) {
      noop_1.noop();
    };
    return IgnoreElementsSubscriber;
  })(Subscriber_1.Subscriber);
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("7b", ["8", "7a"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var ignoreElements_1 = $__require('7a');
  Observable_1.Observable.prototype.ignoreElements = ignoreElements_1.ignoreElements;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("7c", ["7d", "3", "33", "17", "e", "f"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var __extends = (this && this.__extends) || function(d, b) {
    for (var p in b)
      if (b.hasOwnProperty(p))
        d[p] = b[p];
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
  var ScalarObservable_1 = $__require('7d');
  var fromArray_1 = $__require('3');
  var throw_1 = $__require('33');
  var Subscriber_1 = $__require('17');
  var tryCatch_1 = $__require('e');
  var errorObject_1 = $__require('f');
  function every(predicate, thisArg) {
    var source = this;
    var result;
    if (source._isScalar) {
      result = tryCatch_1.tryCatch(predicate).call(thisArg || this, source.value, 0, source);
      if (result === errorObject_1.errorObject) {
        return new throw_1.ErrorObservable(errorObject_1.errorObject.e, source.scheduler);
      } else {
        return new ScalarObservable_1.ScalarObservable(result, source.scheduler);
      }
    }
    if (source instanceof fromArray_1.ArrayObservable) {
      var array = source.array;
      var result_1 = tryCatch_1.tryCatch(function(array, predicate, thisArg) {
        return array.every(predicate, thisArg);
      })(array, predicate, thisArg);
      if (result_1 === errorObject_1.errorObject) {
        return new throw_1.ErrorObservable(errorObject_1.errorObject.e, source.scheduler);
      } else {
        return new ScalarObservable_1.ScalarObservable(result_1, source.scheduler);
      }
    }
    return source.lift(new EveryOperator(predicate, thisArg, source));
  }
  exports.every = every;
  var EveryOperator = (function() {
    function EveryOperator(predicate, thisArg, source) {
      this.predicate = predicate;
      this.thisArg = thisArg;
      this.source = source;
    }
    EveryOperator.prototype.call = function(observer) {
      return new EverySubscriber(observer, this.predicate, this.thisArg, this.source);
    };
    return EveryOperator;
  })();
  var EverySubscriber = (function(_super) {
    __extends(EverySubscriber, _super);
    function EverySubscriber(destination, predicate, thisArg, source) {
      _super.call(this, destination);
      this.predicate = predicate;
      this.thisArg = thisArg;
      this.source = source;
      this.index = 0;
    }
    EverySubscriber.prototype.notifyComplete = function(everyValueMatch) {
      this.destination.next(everyValueMatch);
      this.destination.complete();
    };
    EverySubscriber.prototype._next = function(value) {
      var result = tryCatch_1.tryCatch(this.predicate).call(this.thisArg || this, value, this.index++, this.source);
      if (result === errorObject_1.errorObject) {
        this.destination.error(result.e);
      } else if (!result) {
        this.notifyComplete(false);
      }
    };
    EverySubscriber.prototype._complete = function() {
      this.notifyComplete(true);
    };
    return EverySubscriber;
  })(Subscriber_1.Subscriber);
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("7e", ["8", "7c"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var every_1 = $__require('7c');
  Observable_1.Observable.prototype.every = every_1.every;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("7f", ["17", "e", "f", "71"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var __extends = (this && this.__extends) || function(d, b) {
    for (var p in b)
      if (b.hasOwnProperty(p))
        d[p] = b[p];
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
  var Subscriber_1 = $__require('17');
  var tryCatch_1 = $__require('e');
  var errorObject_1 = $__require('f');
  var EmptyError_1 = $__require('71');
  function last(predicate, resultSelector, defaultValue) {
    return this.lift(new LastOperator(predicate, resultSelector, defaultValue, this));
  }
  exports.last = last;
  var LastOperator = (function() {
    function LastOperator(predicate, resultSelector, defaultValue, source) {
      this.predicate = predicate;
      this.resultSelector = resultSelector;
      this.defaultValue = defaultValue;
      this.source = source;
    }
    LastOperator.prototype.call = function(observer) {
      return new LastSubscriber(observer, this.predicate, this.resultSelector, this.defaultValue, this.source);
    };
    return LastOperator;
  })();
  var LastSubscriber = (function(_super) {
    __extends(LastSubscriber, _super);
    function LastSubscriber(destination, predicate, resultSelector, defaultValue, source) {
      _super.call(this, destination);
      this.predicate = predicate;
      this.resultSelector = resultSelector;
      this.defaultValue = defaultValue;
      this.source = source;
      this.hasValue = false;
      this.index = 0;
      if (typeof defaultValue !== 'undefined') {
        this.lastValue = defaultValue;
        this.hasValue = true;
      }
    }
    LastSubscriber.prototype._next = function(value) {
      var _a = this,
          predicate = _a.predicate,
          resultSelector = _a.resultSelector,
          destination = _a.destination;
      var index = this.index++;
      if (predicate) {
        var found = tryCatch_1.tryCatch(predicate)(value, index, this.source);
        if (found === errorObject_1.errorObject) {
          destination.error(errorObject_1.errorObject.e);
          return;
        }
        if (found) {
          if (resultSelector) {
            var result = tryCatch_1.tryCatch(resultSelector)(value, index);
            if (result === errorObject_1.errorObject) {
              destination.error(errorObject_1.errorObject.e);
              return;
            }
            this.lastValue = result;
          } else {
            this.lastValue = value;
          }
          this.hasValue = true;
        }
      } else {
        this.lastValue = value;
        this.hasValue = true;
      }
    };
    LastSubscriber.prototype._complete = function() {
      var destination = this.destination;
      if (this.hasValue) {
        destination.next(this.lastValue);
        destination.complete();
      } else {
        destination.error(new EmptyError_1.EmptyError);
      }
    };
    return LastSubscriber;
  })(Subscriber_1.Subscriber);
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("80", ["8", "7f"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var last_1 = $__require('7f');
  Observable_1.Observable.prototype.last = last_1.last;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("81", ["17", "e", "f"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var __extends = (this && this.__extends) || function(d, b) {
    for (var p in b)
      if (b.hasOwnProperty(p))
        d[p] = b[p];
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
  var Subscriber_1 = $__require('17');
  var tryCatch_1 = $__require('e');
  var errorObject_1 = $__require('f');
  function map(project, thisArg) {
    if (typeof project !== 'function') {
      throw new TypeError('argument is not a function. Are you looking for `mapTo()`?');
    }
    return this.lift(new MapOperator(project, thisArg));
  }
  exports.map = map;
  var MapOperator = (function() {
    function MapOperator(project, thisArg) {
      this.project = project;
      this.thisArg = thisArg;
    }
    MapOperator.prototype.call = function(subscriber) {
      return new MapSubscriber(subscriber, this.project, this.thisArg);
    };
    return MapOperator;
  })();
  var MapSubscriber = (function(_super) {
    __extends(MapSubscriber, _super);
    function MapSubscriber(destination, project, thisArg) {
      _super.call(this, destination);
      this.project = project;
      this.thisArg = thisArg;
      this.count = 0;
    }
    MapSubscriber.prototype._next = function(x) {
      var result = tryCatch_1.tryCatch(this.project).call(this.thisArg || this, x, this.count++);
      if (result === errorObject_1.errorObject) {
        this.error(errorObject_1.errorObject.e);
      } else {
        this.destination.next(result);
      }
    };
    return MapSubscriber;
  })(Subscriber_1.Subscriber);
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("82", ["8", "81"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var map_1 = $__require('81');
  Observable_1.Observable.prototype.map = map_1.map;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("83", ["17"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var __extends = (this && this.__extends) || function(d, b) {
    for (var p in b)
      if (b.hasOwnProperty(p))
        d[p] = b[p];
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
  var Subscriber_1 = $__require('17');
  function mapTo(value) {
    return this.lift(new MapToOperator(value));
  }
  exports.mapTo = mapTo;
  var MapToOperator = (function() {
    function MapToOperator(value) {
      this.value = value;
    }
    MapToOperator.prototype.call = function(subscriber) {
      return new MapToSubscriber(subscriber, this.value);
    };
    return MapToOperator;
  })();
  var MapToSubscriber = (function(_super) {
    __extends(MapToSubscriber, _super);
    function MapToSubscriber(destination, value) {
      _super.call(this, destination);
      this.value = value;
    }
    MapToSubscriber.prototype._next = function(x) {
      this.destination.next(this.value);
    };
    return MapToSubscriber;
  })(Subscriber_1.Subscriber);
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("84", ["8", "83"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var mapTo_1 = $__require('83');
  Observable_1.Observable.prototype.mapTo = mapTo_1.mapTo;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("85", ["17", "63"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var __extends = (this && this.__extends) || function(d, b) {
    for (var p in b)
      if (b.hasOwnProperty(p))
        d[p] = b[p];
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
  var Subscriber_1 = $__require('17');
  var Notification_1 = $__require('63');
  function materialize() {
    return this.lift(new MaterializeOperator());
  }
  exports.materialize = materialize;
  var MaterializeOperator = (function() {
    function MaterializeOperator() {}
    MaterializeOperator.prototype.call = function(subscriber) {
      return new MaterializeSubscriber(subscriber);
    };
    return MaterializeOperator;
  })();
  var MaterializeSubscriber = (function(_super) {
    __extends(MaterializeSubscriber, _super);
    function MaterializeSubscriber(destination) {
      _super.call(this, destination);
    }
    MaterializeSubscriber.prototype._next = function(value) {
      this.destination.next(Notification_1.Notification.createNext(value));
    };
    MaterializeSubscriber.prototype._error = function(err) {
      var destination = this.destination;
      destination.next(Notification_1.Notification.createError(err));
      destination.complete();
    };
    MaterializeSubscriber.prototype._complete = function() {
      var destination = this.destination;
      destination.next(Notification_1.Notification.createComplete());
      destination.complete();
    };
    return MaterializeSubscriber;
  })(Subscriber_1.Subscriber);
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("86", ["8", "85"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var materialize_1 = $__require('85');
  Observable_1.Observable.prototype.materialize = materialize_1.materialize;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("c", ["3", "4e", "20", "5"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var fromArray_1 = $__require('3');
  var mergeAll_support_1 = $__require('4e');
  var queue_1 = $__require('20');
  var isScheduler_1 = $__require('5');
  function merge() {
    var observables = [];
    for (var _i = 0; _i < arguments.length; _i++) {
      observables[_i - 0] = arguments[_i];
    }
    var concurrent = Number.POSITIVE_INFINITY;
    var scheduler = queue_1.queue;
    var last = observables[observables.length - 1];
    if (isScheduler_1.isScheduler(last)) {
      scheduler = observables.pop();
      if (observables.length > 1 && typeof observables[observables.length - 1] === 'number') {
        concurrent = observables.pop();
      }
    } else if (typeof last === 'number') {
      concurrent = observables.pop();
    }
    if (observables.length === 1) {
      return observables[0];
    }
    return new fromArray_1.ArrayObservable(observables, scheduler).lift(new mergeAll_support_1.MergeAllOperator(concurrent));
  }
  exports.merge = merge;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("87", ["c"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var merge_static_1 = $__require('c');
  function merge() {
    var observables = [];
    for (var _i = 0; _i < arguments.length; _i++) {
      observables[_i - 0] = arguments[_i];
    }
    observables.unshift(this);
    return merge_static_1.merge.apply(this, observables);
  }
  exports.merge = merge;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("88", ["8", "87"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var merge_1 = $__require('87');
  Observable_1.Observable.prototype.merge = merge_1.merge;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("89", ["4e"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var mergeAll_support_1 = $__require('4e');
  function mergeAll(concurrent) {
    if (concurrent === void 0) {
      concurrent = Number.POSITIVE_INFINITY;
    }
    return this.lift(new mergeAll_support_1.MergeAllOperator(concurrent));
  }
  exports.mergeAll = mergeAll;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("8a", ["8", "89"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var mergeAll_1 = $__require('89');
  Observable_1.Observable.prototype.mergeAll = mergeAll_1.mergeAll;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("53", ["e", "f", "4a", "49"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var __extends = (this && this.__extends) || function(d, b) {
    for (var p in b)
      if (b.hasOwnProperty(p))
        d[p] = b[p];
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
  var tryCatch_1 = $__require('e');
  var errorObject_1 = $__require('f');
  var subscribeToResult_1 = $__require('4a');
  var OuterSubscriber_1 = $__require('49');
  var MergeMapOperator = (function() {
    function MergeMapOperator(project, resultSelector, concurrent) {
      if (concurrent === void 0) {
        concurrent = Number.POSITIVE_INFINITY;
      }
      this.project = project;
      this.resultSelector = resultSelector;
      this.concurrent = concurrent;
    }
    MergeMapOperator.prototype.call = function(observer) {
      return new MergeMapSubscriber(observer, this.project, this.resultSelector, this.concurrent);
    };
    return MergeMapOperator;
  })();
  exports.MergeMapOperator = MergeMapOperator;
  var MergeMapSubscriber = (function(_super) {
    __extends(MergeMapSubscriber, _super);
    function MergeMapSubscriber(destination, project, resultSelector, concurrent) {
      if (concurrent === void 0) {
        concurrent = Number.POSITIVE_INFINITY;
      }
      _super.call(this, destination);
      this.project = project;
      this.resultSelector = resultSelector;
      this.concurrent = concurrent;
      this.hasCompleted = false;
      this.buffer = [];
      this.active = 0;
      this.index = 0;
    }
    MergeMapSubscriber.prototype._next = function(value) {
      if (this.active < this.concurrent) {
        var index = this.index++;
        var ish = tryCatch_1.tryCatch(this.project)(value, index);
        var destination = this.destination;
        if (ish === errorObject_1.errorObject) {
          destination.error(ish.e);
        } else {
          this.active++;
          this._innerSub(ish, value, index);
        }
      } else {
        this.buffer.push(value);
      }
    };
    MergeMapSubscriber.prototype._innerSub = function(ish, value, index) {
      this.add(subscribeToResult_1.subscribeToResult(this, ish, value, index));
    };
    MergeMapSubscriber.prototype._complete = function() {
      this.hasCompleted = true;
      if (this.active === 0 && this.buffer.length === 0) {
        this.destination.complete();
      }
    };
    MergeMapSubscriber.prototype.notifyNext = function(outerValue, innerValue, outerIndex, innerIndex) {
      var _a = this,
          destination = _a.destination,
          resultSelector = _a.resultSelector;
      if (resultSelector) {
        var result = tryCatch_1.tryCatch(resultSelector)(outerValue, innerValue, outerIndex, innerIndex);
        if (result === errorObject_1.errorObject) {
          destination.error(errorObject_1.errorObject.e);
        } else {
          destination.next(result);
        }
      } else {
        destination.next(innerValue);
      }
    };
    MergeMapSubscriber.prototype.notifyComplete = function(innerSub) {
      var buffer = this.buffer;
      this.remove(innerSub);
      this.active--;
      if (buffer.length > 0) {
        this._next(buffer.shift());
      } else if (this.active === 0 && this.hasCompleted) {
        this.destination.complete();
      }
    };
    return MergeMapSubscriber;
  })(OuterSubscriber_1.OuterSubscriber);
  exports.MergeMapSubscriber = MergeMapSubscriber;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("8b", ["53"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var mergeMap_support_1 = $__require('53');
  function mergeMap(project, resultSelector, concurrent) {
    if (concurrent === void 0) {
      concurrent = Number.POSITIVE_INFINITY;
    }
    return this.lift(new mergeMap_support_1.MergeMapOperator(project, resultSelector, concurrent));
  }
  exports.mergeMap = mergeMap;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("8c", ["8", "8b"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var mergeMap_1 = $__require('8b');
  Observable_1.Observable.prototype.mergeMap = mergeMap_1.mergeMap;
  Observable_1.Observable.prototype.flatMap = mergeMap_1.mergeMap;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("56", ["e", "f", "49", "4a"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var __extends = (this && this.__extends) || function(d, b) {
    for (var p in b)
      if (b.hasOwnProperty(p))
        d[p] = b[p];
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
  var tryCatch_1 = $__require('e');
  var errorObject_1 = $__require('f');
  var OuterSubscriber_1 = $__require('49');
  var subscribeToResult_1 = $__require('4a');
  var MergeMapToOperator = (function() {
    function MergeMapToOperator(ish, resultSelector, concurrent) {
      if (concurrent === void 0) {
        concurrent = Number.POSITIVE_INFINITY;
      }
      this.ish = ish;
      this.resultSelector = resultSelector;
      this.concurrent = concurrent;
    }
    MergeMapToOperator.prototype.call = function(observer) {
      return new MergeMapToSubscriber(observer, this.ish, this.resultSelector, this.concurrent);
    };
    return MergeMapToOperator;
  })();
  exports.MergeMapToOperator = MergeMapToOperator;
  var MergeMapToSubscriber = (function(_super) {
    __extends(MergeMapToSubscriber, _super);
    function MergeMapToSubscriber(destination, ish, resultSelector, concurrent) {
      if (concurrent === void 0) {
        concurrent = Number.POSITIVE_INFINITY;
      }
      _super.call(this, destination);
      this.ish = ish;
      this.resultSelector = resultSelector;
      this.concurrent = concurrent;
      this.hasCompleted = false;
      this.buffer = [];
      this.active = 0;
      this.index = 0;
    }
    MergeMapToSubscriber.prototype._next = function(value) {
      if (this.active < this.concurrent) {
        var resultSelector = this.resultSelector;
        var index = this.index++;
        var ish = this.ish;
        var destination = this.destination;
        this.active++;
        this._innerSub(ish, destination, resultSelector, value, index);
      } else {
        this.buffer.push(value);
      }
    };
    MergeMapToSubscriber.prototype._innerSub = function(ish, destination, resultSelector, value, index) {
      this.add(subscribeToResult_1.subscribeToResult(this, ish, value, index));
    };
    MergeMapToSubscriber.prototype._complete = function() {
      this.hasCompleted = true;
      if (this.active === 0 && this.buffer.length === 0) {
        this.destination.complete();
      }
    };
    MergeMapToSubscriber.prototype.notifyNext = function(outerValue, innerValue, outerIndex, innerIndex) {
      var _a = this,
          resultSelector = _a.resultSelector,
          destination = _a.destination;
      if (resultSelector) {
        var result = tryCatch_1.tryCatch(resultSelector)(outerValue, innerValue, outerIndex, innerIndex);
        if (result === errorObject_1.errorObject) {
          destination.error(errorObject_1.errorObject.e);
        } else {
          destination.next(result);
        }
      } else {
        destination.next(innerValue);
      }
    };
    MergeMapToSubscriber.prototype.notifyError = function(err) {
      this.destination.error(err);
    };
    MergeMapToSubscriber.prototype.notifyComplete = function(innerSub) {
      var buffer = this.buffer;
      this.remove(innerSub);
      this.active--;
      if (buffer.length > 0) {
        this._next(buffer.shift());
      } else if (this.active === 0 && this.hasCompleted) {
        this.destination.complete();
      }
    };
    return MergeMapToSubscriber;
  })(OuterSubscriber_1.OuterSubscriber);
  exports.MergeMapToSubscriber = MergeMapToSubscriber;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("8d", ["56"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var mergeMapTo_support_1 = $__require('56');
  function mergeMapTo(observable, resultSelector, concurrent) {
    if (concurrent === void 0) {
      concurrent = Number.POSITIVE_INFINITY;
    }
    return this.lift(new mergeMapTo_support_1.MergeMapToOperator(observable, resultSelector, concurrent));
  }
  exports.mergeMapTo = mergeMapTo;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("8e", ["8", "8d"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var mergeMapTo_1 = $__require('8d');
  Observable_1.Observable.prototype.mergeMapTo = mergeMapTo_1.mergeMapTo;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("8f", ["8", "90"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var multicast_1 = $__require('90');
  Observable_1.Observable.prototype.multicast = multicast_1.multicast;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("1f", ["17", "63"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var __extends = (this && this.__extends) || function(d, b) {
    for (var p in b)
      if (b.hasOwnProperty(p))
        d[p] = b[p];
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
  var Subscriber_1 = $__require('17');
  var Notification_1 = $__require('63');
  var ObserveOnOperator = (function() {
    function ObserveOnOperator(scheduler, delay) {
      if (delay === void 0) {
        delay = 0;
      }
      this.scheduler = scheduler;
      this.delay = delay;
    }
    ObserveOnOperator.prototype.call = function(subscriber) {
      return new ObserveOnSubscriber(subscriber, this.scheduler, this.delay);
    };
    return ObserveOnOperator;
  })();
  exports.ObserveOnOperator = ObserveOnOperator;
  var ObserveOnSubscriber = (function(_super) {
    __extends(ObserveOnSubscriber, _super);
    function ObserveOnSubscriber(destination, scheduler, delay) {
      if (delay === void 0) {
        delay = 0;
      }
      _super.call(this, destination);
      this.scheduler = scheduler;
      this.delay = delay;
    }
    ObserveOnSubscriber.dispatch = function(_a) {
      var notification = _a.notification,
          destination = _a.destination;
      notification.observe(destination);
    };
    ObserveOnSubscriber.prototype.scheduleMessage = function(notification) {
      this.add(this.scheduler.schedule(ObserveOnSubscriber.dispatch, this.delay, new ObserveOnMessage(notification, this.destination)));
    };
    ObserveOnSubscriber.prototype._next = function(value) {
      this.scheduleMessage(Notification_1.Notification.createNext(value));
    };
    ObserveOnSubscriber.prototype._error = function(err) {
      this.scheduleMessage(Notification_1.Notification.createError(err));
    };
    ObserveOnSubscriber.prototype._complete = function() {
      this.scheduleMessage(Notification_1.Notification.createComplete());
    };
    return ObserveOnSubscriber;
  })(Subscriber_1.Subscriber);
  exports.ObserveOnSubscriber = ObserveOnSubscriber;
  var ObserveOnMessage = (function() {
    function ObserveOnMessage(notification, destination) {
      this.notification = notification;
      this.destination = destination;
    }
    return ObserveOnMessage;
  })();
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("91", ["1f"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var observeOn_support_1 = $__require('1f');
  function observeOn(scheduler, delay) {
    if (delay === void 0) {
      delay = 0;
    }
    return this.lift(new observeOn_support_1.ObserveOnOperator(scheduler, delay));
  }
  exports.observeOn = observeOn;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("92", ["8", "91"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var observeOn_1 = $__require('91');
  Observable_1.Observable.prototype.observeOn = observeOn_1.observeOn;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("93", [], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  function not(pred, thisArg) {
    function notPred() {
      return !(notPred.pred.apply(notPred.thisArg, arguments));
    }
    notPred.pred = pred;
    notPred.thisArg = thisArg;
    return notPred;
  }
  exports.not = not;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("6d", ["17", "e", "f"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var __extends = (this && this.__extends) || function(d, b) {
    for (var p in b)
      if (b.hasOwnProperty(p))
        d[p] = b[p];
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
  var Subscriber_1 = $__require('17');
  var tryCatch_1 = $__require('e');
  var errorObject_1 = $__require('f');
  function filter(select, thisArg) {
    return this.lift(new FilterOperator(select, thisArg));
  }
  exports.filter = filter;
  var FilterOperator = (function() {
    function FilterOperator(select, thisArg) {
      this.select = select;
      this.thisArg = thisArg;
    }
    FilterOperator.prototype.call = function(subscriber) {
      return new FilterSubscriber(subscriber, this.select, this.thisArg);
    };
    return FilterOperator;
  })();
  var FilterSubscriber = (function(_super) {
    __extends(FilterSubscriber, _super);
    function FilterSubscriber(destination, select, thisArg) {
      _super.call(this, destination);
      this.thisArg = thisArg;
      this.count = 0;
      this.select = select;
    }
    FilterSubscriber.prototype._next = function(x) {
      var result = tryCatch_1.tryCatch(this.select).call(this.thisArg || this, x, this.count++);
      if (result === errorObject_1.errorObject) {
        this.destination.error(errorObject_1.errorObject.e);
      } else if (Boolean(result)) {
        this.destination.next(x);
      }
    };
    return FilterSubscriber;
  })(Subscriber_1.Subscriber);
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("94", ["93", "6d"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var not_1 = $__require('93');
  var filter_1 = $__require('6d');
  function partition(predicate, thisArg) {
    return [filter_1.filter.call(this, predicate), filter_1.filter.call(this, not_1.not(predicate, thisArg))];
  }
  exports.partition = partition;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("95", ["8", "94"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var partition_1 = $__require('94');
  Observable_1.Observable.prototype.partition = partition_1.partition;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("96", ["78", "90"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Subject_1 = $__require('78');
  var multicast_1 = $__require('90');
  function publish() {
    return multicast_1.multicast.call(this, new Subject_1.Subject());
  }
  exports.publish = publish;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("97", ["8", "96"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var publish_1 = $__require('96');
  Observable_1.Observable.prototype.publish = publish_1.publish;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("98", ["99", "90"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var BehaviorSubject_1 = $__require('99');
  var multicast_1 = $__require('90');
  function publishBehavior(value) {
    return multicast_1.multicast.call(this, new BehaviorSubject_1.BehaviorSubject(value));
  }
  exports.publishBehavior = publishBehavior;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("9a", ["8", "98"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var publishBehavior_1 = $__require('98');
  Observable_1.Observable.prototype.publishBehavior = publishBehavior_1.publishBehavior;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("9b", ["9c", "90"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var ReplaySubject_1 = $__require('9c');
  var multicast_1 = $__require('90');
  function publishReplay(bufferSize, windowTime, scheduler) {
    if (bufferSize === void 0) {
      bufferSize = Number.POSITIVE_INFINITY;
    }
    if (windowTime === void 0) {
      windowTime = Number.POSITIVE_INFINITY;
    }
    return multicast_1.multicast.call(this, new ReplaySubject_1.ReplaySubject(bufferSize, windowTime, scheduler));
  }
  exports.publishReplay = publishReplay;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("9d", ["8", "9b"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var publishReplay_1 = $__require('9b');
  Observable_1.Observable.prototype.publishReplay = publishReplay_1.publishReplay;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("9e", ["10", "90"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var AsyncSubject_1 = $__require('10');
  var multicast_1 = $__require('90');
  function publishLast() {
    return multicast_1.multicast.call(this, new AsyncSubject_1.AsyncSubject());
  }
  exports.publishLast = publishLast;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("9f", ["8", "9e"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var publishLast_1 = $__require('9e');
  Observable_1.Observable.prototype.publishLast = publishLast_1.publishLast;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("a0", ["17", "e", "f"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var __extends = (this && this.__extends) || function(d, b) {
    for (var p in b)
      if (b.hasOwnProperty(p))
        d[p] = b[p];
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
  var Subscriber_1 = $__require('17');
  var tryCatch_1 = $__require('e');
  var errorObject_1 = $__require('f');
  var ReduceOperator = (function() {
    function ReduceOperator(project, seed) {
      this.project = project;
      this.seed = seed;
    }
    ReduceOperator.prototype.call = function(subscriber) {
      return new ReduceSubscriber(subscriber, this.project, this.seed);
    };
    return ReduceOperator;
  })();
  exports.ReduceOperator = ReduceOperator;
  var ReduceSubscriber = (function(_super) {
    __extends(ReduceSubscriber, _super);
    function ReduceSubscriber(destination, project, seed) {
      _super.call(this, destination);
      this.hasValue = false;
      this.acc = seed;
      this.project = project;
      this.hasSeed = typeof seed !== 'undefined';
    }
    ReduceSubscriber.prototype._next = function(x) {
      if (this.hasValue || (this.hasValue = this.hasSeed)) {
        var result = tryCatch_1.tryCatch(this.project).call(this, this.acc, x);
        if (result === errorObject_1.errorObject) {
          this.destination.error(errorObject_1.errorObject.e);
        } else {
          this.acc = result;
        }
      } else {
        this.acc = x;
        this.hasValue = true;
      }
    };
    ReduceSubscriber.prototype._complete = function() {
      if (this.hasValue || this.hasSeed) {
        this.destination.next(this.acc);
      }
      this.destination.complete();
    };
    return ReduceSubscriber;
  })(Subscriber_1.Subscriber);
  exports.ReduceSubscriber = ReduceSubscriber;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("a1", ["a0"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var reduce_support_1 = $__require('a0');
  function reduce(project, seed) {
    return this.lift(new reduce_support_1.ReduceOperator(project, seed));
  }
  exports.reduce = reduce;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("a2", ["8", "a1"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var reduce_1 = $__require('a1');
  Observable_1.Observable.prototype.reduce = reduce_1.reduce;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("a3", ["17", "15"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var __extends = (this && this.__extends) || function(d, b) {
    for (var p in b)
      if (b.hasOwnProperty(p))
        d[p] = b[p];
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
  var Subscriber_1 = $__require('17');
  var empty_1 = $__require('15');
  function repeat(count) {
    if (count === void 0) {
      count = -1;
    }
    if (count === 0) {
      return new empty_1.EmptyObservable();
    } else {
      return this.lift(new RepeatOperator(count, this));
    }
  }
  exports.repeat = repeat;
  var RepeatOperator = (function() {
    function RepeatOperator(count, source) {
      this.count = count;
      this.source = source;
    }
    RepeatOperator.prototype.call = function(subscriber) {
      return new FirstRepeatSubscriber(subscriber, this.count, this.source);
    };
    return RepeatOperator;
  })();
  var FirstRepeatSubscriber = (function(_super) {
    __extends(FirstRepeatSubscriber, _super);
    function FirstRepeatSubscriber(destination, count, source) {
      _super.call(this);
      this.destination = destination;
      this.count = count;
      this.source = source;
      destination.add(this);
      this.lastSubscription = this;
    }
    FirstRepeatSubscriber.prototype._next = function(value) {
      this.destination.next(value);
    };
    FirstRepeatSubscriber.prototype._error = function(err) {
      this.destination.error(err);
    };
    FirstRepeatSubscriber.prototype.complete = function() {
      if (!this.isUnsubscribed) {
        this.resubscribe(this.count);
      }
    };
    FirstRepeatSubscriber.prototype.unsubscribe = function() {
      var lastSubscription = this.lastSubscription;
      if (lastSubscription === this) {
        _super.prototype.unsubscribe.call(this);
      } else {
        lastSubscription.unsubscribe();
      }
    };
    FirstRepeatSubscriber.prototype.resubscribe = function(count) {
      var _a = this,
          destination = _a.destination,
          lastSubscription = _a.lastSubscription;
      destination.remove(lastSubscription);
      lastSubscription.unsubscribe();
      if (count - 1 === 0) {
        destination.complete();
      } else {
        var nextSubscriber = new MoreRepeatSubscriber(this, count - 1);
        this.lastSubscription = this.source.subscribe(nextSubscriber);
        destination.add(this.lastSubscription);
      }
    };
    return FirstRepeatSubscriber;
  })(Subscriber_1.Subscriber);
  var MoreRepeatSubscriber = (function(_super) {
    __extends(MoreRepeatSubscriber, _super);
    function MoreRepeatSubscriber(parent, count) {
      _super.call(this);
      this.parent = parent;
      this.count = count;
    }
    MoreRepeatSubscriber.prototype._next = function(value) {
      this.parent.destination.next(value);
    };
    MoreRepeatSubscriber.prototype._error = function(err) {
      this.parent.destination.error(err);
    };
    MoreRepeatSubscriber.prototype._complete = function() {
      var count = this.count;
      this.parent.resubscribe(count < 0 ? -1 : count);
    };
    return MoreRepeatSubscriber;
  })(Subscriber_1.Subscriber);
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("a4", ["8", "a3"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var repeat_1 = $__require('a3');
  Observable_1.Observable.prototype.repeat = repeat_1.repeat;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("a5", ["17"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var __extends = (this && this.__extends) || function(d, b) {
    for (var p in b)
      if (b.hasOwnProperty(p))
        d[p] = b[p];
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
  var Subscriber_1 = $__require('17');
  function retry(count) {
    if (count === void 0) {
      count = 0;
    }
    return this.lift(new RetryOperator(count, this));
  }
  exports.retry = retry;
  var RetryOperator = (function() {
    function RetryOperator(count, source) {
      this.count = count;
      this.source = source;
    }
    RetryOperator.prototype.call = function(subscriber) {
      return new FirstRetrySubscriber(subscriber, this.count, this.source);
    };
    return RetryOperator;
  })();
  var FirstRetrySubscriber = (function(_super) {
    __extends(FirstRetrySubscriber, _super);
    function FirstRetrySubscriber(destination, count, source) {
      _super.call(this);
      this.destination = destination;
      this.count = count;
      this.source = source;
      destination.add(this);
      this.lastSubscription = this;
    }
    FirstRetrySubscriber.prototype._next = function(value) {
      this.destination.next(value);
    };
    FirstRetrySubscriber.prototype.error = function(error) {
      if (!this.isUnsubscribed) {
        this.unsubscribe();
        this.resubscribe();
      }
    };
    FirstRetrySubscriber.prototype._complete = function() {
      this.unsubscribe();
      this.destination.complete();
    };
    FirstRetrySubscriber.prototype.resubscribe = function(retried) {
      if (retried === void 0) {
        retried = 0;
      }
      var _a = this,
          lastSubscription = _a.lastSubscription,
          destination = _a.destination;
      destination.remove(lastSubscription);
      lastSubscription.unsubscribe();
      var nextSubscriber = new RetryMoreSubscriber(this, this.count, retried + 1);
      this.lastSubscription = this.source.subscribe(nextSubscriber);
      destination.add(this.lastSubscription);
    };
    return FirstRetrySubscriber;
  })(Subscriber_1.Subscriber);
  var RetryMoreSubscriber = (function(_super) {
    __extends(RetryMoreSubscriber, _super);
    function RetryMoreSubscriber(parent, count, retried) {
      if (retried === void 0) {
        retried = 0;
      }
      _super.call(this, null);
      this.parent = parent;
      this.count = count;
      this.retried = retried;
    }
    RetryMoreSubscriber.prototype._next = function(value) {
      this.parent.destination.next(value);
    };
    RetryMoreSubscriber.prototype._error = function(err) {
      var parent = this.parent;
      var retried = this.retried;
      var count = this.count;
      if (count && retried === count) {
        parent.destination.error(err);
      } else {
        parent.resubscribe(retried);
      }
    };
    RetryMoreSubscriber.prototype._complete = function() {
      this.parent.destination.complete();
    };
    return RetryMoreSubscriber;
  })(Subscriber_1.Subscriber);
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("a6", ["8", "a5"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var retry_1 = $__require('a5');
  Observable_1.Observable.prototype.retry = retry_1.retry;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("a7", ["17", "78", "e", "f"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var __extends = (this && this.__extends) || function(d, b) {
    for (var p in b)
      if (b.hasOwnProperty(p))
        d[p] = b[p];
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
  var Subscriber_1 = $__require('17');
  var Subject_1 = $__require('78');
  var tryCatch_1 = $__require('e');
  var errorObject_1 = $__require('f');
  function retryWhen(notifier) {
    return this.lift(new RetryWhenOperator(notifier, this));
  }
  exports.retryWhen = retryWhen;
  var RetryWhenOperator = (function() {
    function RetryWhenOperator(notifier, source) {
      this.notifier = notifier;
      this.source = source;
    }
    RetryWhenOperator.prototype.call = function(subscriber) {
      return new FirstRetryWhenSubscriber(subscriber, this.notifier, this.source);
    };
    return RetryWhenOperator;
  })();
  var FirstRetryWhenSubscriber = (function(_super) {
    __extends(FirstRetryWhenSubscriber, _super);
    function FirstRetryWhenSubscriber(destination, notifier, source) {
      _super.call(this);
      this.destination = destination;
      this.notifier = notifier;
      this.source = source;
      destination.add(this);
      this.lastSubscription = this;
    }
    FirstRetryWhenSubscriber.prototype._next = function(value) {
      this.destination.next(value);
    };
    FirstRetryWhenSubscriber.prototype.error = function(err) {
      var destination = this.destination;
      if (!this.isUnsubscribed) {
        _super.prototype.unsubscribe.call(this);
        if (!this.retryNotifications) {
          this.errors = new Subject_1.Subject();
          var notifications = tryCatch_1.tryCatch(this.notifier).call(this, this.errors);
          if (notifications === errorObject_1.errorObject) {
            destination.error(errorObject_1.errorObject.e);
          } else {
            this.retryNotifications = notifications;
            var notificationSubscriber = new RetryNotificationSubscriber(this);
            this.notificationSubscription = notifications.subscribe(notificationSubscriber);
            destination.add(this.notificationSubscription);
          }
        }
        this.errors.next(err);
      }
    };
    FirstRetryWhenSubscriber.prototype.destinationError = function(err) {
      this.tearDown();
      this.destination.error(err);
    };
    FirstRetryWhenSubscriber.prototype._complete = function() {
      this.destinationComplete();
    };
    FirstRetryWhenSubscriber.prototype.destinationComplete = function() {
      this.tearDown();
      this.destination.complete();
    };
    FirstRetryWhenSubscriber.prototype.unsubscribe = function() {
      var lastSubscription = this.lastSubscription;
      if (lastSubscription === this) {
        _super.prototype.unsubscribe.call(this);
      } else {
        this.tearDown();
      }
    };
    FirstRetryWhenSubscriber.prototype.tearDown = function() {
      _super.prototype.unsubscribe.call(this);
      this.lastSubscription.unsubscribe();
      var notificationSubscription = this.notificationSubscription;
      if (notificationSubscription) {
        notificationSubscription.unsubscribe();
      }
    };
    FirstRetryWhenSubscriber.prototype.resubscribe = function() {
      var _a = this,
          destination = _a.destination,
          lastSubscription = _a.lastSubscription;
      destination.remove(lastSubscription);
      lastSubscription.unsubscribe();
      var nextSubscriber = new MoreRetryWhenSubscriber(this);
      this.lastSubscription = this.source.subscribe(nextSubscriber);
      destination.add(this.lastSubscription);
    };
    return FirstRetryWhenSubscriber;
  })(Subscriber_1.Subscriber);
  var MoreRetryWhenSubscriber = (function(_super) {
    __extends(MoreRetryWhenSubscriber, _super);
    function MoreRetryWhenSubscriber(parent) {
      _super.call(this, null);
      this.parent = parent;
    }
    MoreRetryWhenSubscriber.prototype._next = function(value) {
      this.parent.destination.next(value);
    };
    MoreRetryWhenSubscriber.prototype._error = function(err) {
      this.parent.errors.next(err);
    };
    MoreRetryWhenSubscriber.prototype._complete = function() {
      this.parent.destinationComplete();
    };
    return MoreRetryWhenSubscriber;
  })(Subscriber_1.Subscriber);
  var RetryNotificationSubscriber = (function(_super) {
    __extends(RetryNotificationSubscriber, _super);
    function RetryNotificationSubscriber(parent) {
      _super.call(this, null);
      this.parent = parent;
    }
    RetryNotificationSubscriber.prototype._next = function(value) {
      this.parent.resubscribe();
    };
    RetryNotificationSubscriber.prototype._error = function(err) {
      this.parent.destinationError(err);
    };
    RetryNotificationSubscriber.prototype._complete = function() {
      this.parent.destinationComplete();
    };
    return RetryNotificationSubscriber;
  })(Subscriber_1.Subscriber);
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("a8", ["8", "a7"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var retryWhen_1 = $__require('a7');
  Observable_1.Observable.prototype.retryWhen = retryWhen_1.retryWhen;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("a9", ["17"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var __extends = (this && this.__extends) || function(d, b) {
    for (var p in b)
      if (b.hasOwnProperty(p))
        d[p] = b[p];
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
  var Subscriber_1 = $__require('17');
  function sample(notifier) {
    return this.lift(new SampleOperator(notifier));
  }
  exports.sample = sample;
  var SampleOperator = (function() {
    function SampleOperator(notifier) {
      this.notifier = notifier;
    }
    SampleOperator.prototype.call = function(subscriber) {
      return new SampleSubscriber(subscriber, this.notifier);
    };
    return SampleOperator;
  })();
  var SampleSubscriber = (function(_super) {
    __extends(SampleSubscriber, _super);
    function SampleSubscriber(destination, notifier) {
      _super.call(this, destination);
      this.notifier = notifier;
      this.hasValue = false;
      this.add(notifier._subscribe(new SampleNotificationSubscriber(this)));
    }
    SampleSubscriber.prototype._next = function(value) {
      this.lastValue = value;
      this.hasValue = true;
    };
    SampleSubscriber.prototype.notifyNext = function() {
      if (this.hasValue) {
        this.hasValue = false;
        this.destination.next(this.lastValue);
      }
    };
    return SampleSubscriber;
  })(Subscriber_1.Subscriber);
  var SampleNotificationSubscriber = (function(_super) {
    __extends(SampleNotificationSubscriber, _super);
    function SampleNotificationSubscriber(parent) {
      _super.call(this, null);
      this.parent = parent;
    }
    SampleNotificationSubscriber.prototype._next = function() {
      this.parent.notifyNext();
    };
    SampleNotificationSubscriber.prototype._error = function(err) {
      this.parent.error(err);
    };
    SampleNotificationSubscriber.prototype._complete = function() {
      this.parent.notifyNext();
    };
    return SampleNotificationSubscriber;
  })(Subscriber_1.Subscriber);
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("aa", ["8", "a9"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var sample_1 = $__require('a9');
  Observable_1.Observable.prototype.sample = sample_1.sample;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("ab", ["17", "2b"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var __extends = (this && this.__extends) || function(d, b) {
    for (var p in b)
      if (b.hasOwnProperty(p))
        d[p] = b[p];
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
  var Subscriber_1 = $__require('17');
  var asap_1 = $__require('2b');
  function sampleTime(delay, scheduler) {
    if (scheduler === void 0) {
      scheduler = asap_1.asap;
    }
    return this.lift(new SampleTimeOperator(delay, scheduler));
  }
  exports.sampleTime = sampleTime;
  var SampleTimeOperator = (function() {
    function SampleTimeOperator(delay, scheduler) {
      this.delay = delay;
      this.scheduler = scheduler;
    }
    SampleTimeOperator.prototype.call = function(subscriber) {
      return new SampleTimeSubscriber(subscriber, this.delay, this.scheduler);
    };
    return SampleTimeOperator;
  })();
  var SampleTimeSubscriber = (function(_super) {
    __extends(SampleTimeSubscriber, _super);
    function SampleTimeSubscriber(destination, delay, scheduler) {
      _super.call(this, destination);
      this.delay = delay;
      this.scheduler = scheduler;
      this.hasValue = false;
      this.add(scheduler.schedule(dispatchNotification, delay, {
        subscriber: this,
        delay: delay
      }));
    }
    SampleTimeSubscriber.prototype._next = function(value) {
      this.lastValue = value;
      this.hasValue = true;
    };
    SampleTimeSubscriber.prototype.notifyNext = function() {
      if (this.hasValue) {
        this.hasValue = false;
        this.destination.next(this.lastValue);
      }
    };
    return SampleTimeSubscriber;
  })(Subscriber_1.Subscriber);
  function dispatchNotification(state) {
    var subscriber = state.subscriber,
        delay = state.delay;
    subscriber.notifyNext();
    this.schedule(state, delay);
  }
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("ac", ["8", "ab"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var sampleTime_1 = $__require('ab');
  Observable_1.Observable.prototype.sampleTime = sampleTime_1.sampleTime;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("ad", ["17", "e", "f"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var __extends = (this && this.__extends) || function(d, b) {
    for (var p in b)
      if (b.hasOwnProperty(p))
        d[p] = b[p];
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
  var Subscriber_1 = $__require('17');
  var tryCatch_1 = $__require('e');
  var errorObject_1 = $__require('f');
  function scan(accumulator, seed) {
    return this.lift(new ScanOperator(accumulator, seed));
  }
  exports.scan = scan;
  var ScanOperator = (function() {
    function ScanOperator(accumulator, seed) {
      this.accumulator = accumulator;
      this.seed = seed;
    }
    ScanOperator.prototype.call = function(subscriber) {
      return new ScanSubscriber(subscriber, this.accumulator, this.seed);
    };
    return ScanOperator;
  })();
  var ScanSubscriber = (function(_super) {
    __extends(ScanSubscriber, _super);
    function ScanSubscriber(destination, accumulator, seed) {
      _super.call(this, destination);
      this.accumulator = accumulator;
      this.accumulatorSet = false;
      this.seed = seed;
      this.accumulator = accumulator;
      this.accumulatorSet = typeof seed !== 'undefined';
    }
    Object.defineProperty(ScanSubscriber.prototype, "seed", {
      get: function() {
        return this._seed;
      },
      set: function(value) {
        this.accumulatorSet = true;
        this._seed = value;
      },
      enumerable: true,
      configurable: true
    });
    ScanSubscriber.prototype._next = function(value) {
      if (!this.accumulatorSet) {
        this.seed = value;
        this.destination.next(value);
      } else {
        var result = tryCatch_1.tryCatch(this.accumulator).call(this, this.seed, value);
        if (result === errorObject_1.errorObject) {
          this.destination.error(errorObject_1.errorObject.e);
        } else {
          this.seed = result;
          this.destination.next(this.seed);
        }
      }
    };
    return ScanSubscriber;
  })(Subscriber_1.Subscriber);
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("ae", ["8", "ad"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var scan_1 = $__require('ad');
  Observable_1.Observable.prototype.scan = scan_1.scan;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("90", ["af"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var ConnectableObservable_1 = $__require('af');
  function multicast(subjectOrSubjectFactory) {
    var subjectFactory;
    if (typeof subjectOrSubjectFactory === 'function') {
      subjectFactory = subjectOrSubjectFactory;
    } else {
      subjectFactory = function subjectFactory() {
        return subjectOrSubjectFactory;
      };
    }
    return new ConnectableObservable_1.ConnectableObservable(this, subjectFactory);
  }
  exports.multicast = multicast;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("b0", ["90", "78"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var multicast_1 = $__require('90');
  var Subject_1 = $__require('78');
  function shareSubjectFactory() {
    return new Subject_1.Subject();
  }
  function share() {
    return multicast_1.multicast.call(this, shareSubjectFactory).refCount();
  }
  exports.share = share;
  ;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("b1", ["8", "b0"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var share_1 = $__require('b0');
  Observable_1.Observable.prototype.share = share_1.share;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("b2", ["17", "e", "f", "71"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var __extends = (this && this.__extends) || function(d, b) {
    for (var p in b)
      if (b.hasOwnProperty(p))
        d[p] = b[p];
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
  var Subscriber_1 = $__require('17');
  var tryCatch_1 = $__require('e');
  var errorObject_1 = $__require('f');
  var EmptyError_1 = $__require('71');
  function single(predicate) {
    return this.lift(new SingleOperator(predicate, this));
  }
  exports.single = single;
  var SingleOperator = (function() {
    function SingleOperator(predicate, source) {
      this.predicate = predicate;
      this.source = source;
    }
    SingleOperator.prototype.call = function(subscriber) {
      return new SingleSubscriber(subscriber, this.predicate, this.source);
    };
    return SingleOperator;
  })();
  var SingleSubscriber = (function(_super) {
    __extends(SingleSubscriber, _super);
    function SingleSubscriber(destination, predicate, source) {
      _super.call(this, destination);
      this.predicate = predicate;
      this.source = source;
      this.seenValue = false;
      this.index = 0;
    }
    SingleSubscriber.prototype.applySingleValue = function(value) {
      if (this.seenValue) {
        this.destination.error('Sequence contains more than one element');
      } else {
        this.seenValue = true;
        this.singleValue = value;
      }
    };
    SingleSubscriber.prototype._next = function(value) {
      var predicate = this.predicate;
      var currentIndex = this.index++;
      if (predicate) {
        var result = tryCatch_1.tryCatch(predicate)(value, currentIndex, this.source);
        if (result === errorObject_1.errorObject) {
          this.destination.error(result.e);
        } else if (result) {
          this.applySingleValue(value);
        }
      } else {
        this.applySingleValue(value);
      }
    };
    SingleSubscriber.prototype._complete = function() {
      var destination = this.destination;
      if (this.index > 0) {
        destination.next(this.seenValue ? this.singleValue : undefined);
        destination.complete();
      } else {
        destination.error(new EmptyError_1.EmptyError);
      }
    };
    return SingleSubscriber;
  })(Subscriber_1.Subscriber);
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("b3", ["8", "b2"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var single_1 = $__require('b2');
  Observable_1.Observable.prototype.single = single_1.single;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("b4", ["17"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var __extends = (this && this.__extends) || function(d, b) {
    for (var p in b)
      if (b.hasOwnProperty(p))
        d[p] = b[p];
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
  var Subscriber_1 = $__require('17');
  function skip(total) {
    return this.lift(new SkipOperator(total));
  }
  exports.skip = skip;
  var SkipOperator = (function() {
    function SkipOperator(total) {
      this.total = total;
    }
    SkipOperator.prototype.call = function(subscriber) {
      return new SkipSubscriber(subscriber, this.total);
    };
    return SkipOperator;
  })();
  var SkipSubscriber = (function(_super) {
    __extends(SkipSubscriber, _super);
    function SkipSubscriber(destination, total) {
      _super.call(this, destination);
      this.total = total;
      this.count = 0;
    }
    SkipSubscriber.prototype._next = function(x) {
      if (++this.count > this.total) {
        this.destination.next(x);
      }
    };
    return SkipSubscriber;
  })(Subscriber_1.Subscriber);
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("b5", ["8", "b4"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var skip_1 = $__require('b4');
  Observable_1.Observable.prototype.skip = skip_1.skip;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("b6", ["17"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var __extends = (this && this.__extends) || function(d, b) {
    for (var p in b)
      if (b.hasOwnProperty(p))
        d[p] = b[p];
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
  var Subscriber_1 = $__require('17');
  function skipUntil(notifier) {
    return this.lift(new SkipUntilOperator(notifier));
  }
  exports.skipUntil = skipUntil;
  var SkipUntilOperator = (function() {
    function SkipUntilOperator(notifier) {
      this.notifier = notifier;
    }
    SkipUntilOperator.prototype.call = function(subscriber) {
      return new SkipUntilSubscriber(subscriber, this.notifier);
    };
    return SkipUntilOperator;
  })();
  var SkipUntilSubscriber = (function(_super) {
    __extends(SkipUntilSubscriber, _super);
    function SkipUntilSubscriber(destination, notifier) {
      _super.call(this, destination);
      this.notifier = notifier;
      this.notificationSubscriber = null;
      this.notificationSubscriber = new NotificationSubscriber(this);
      this.add(this.notifier.subscribe(this.notificationSubscriber));
    }
    SkipUntilSubscriber.prototype._next = function(value) {
      if (this.notificationSubscriber.hasValue) {
        this.destination.next(value);
      }
    };
    SkipUntilSubscriber.prototype._error = function(err) {
      this.destination.error(err);
    };
    SkipUntilSubscriber.prototype._complete = function() {
      if (this.notificationSubscriber.hasCompleted) {
        this.destination.complete();
      }
      this.notificationSubscriber.unsubscribe();
    };
    SkipUntilSubscriber.prototype.unsubscribe = function() {
      if (this._isUnsubscribed) {
        return;
      } else if (this._subscription) {
        this._subscription.unsubscribe();
        this._isUnsubscribed = true;
      } else {
        _super.prototype.unsubscribe.call(this);
      }
    };
    return SkipUntilSubscriber;
  })(Subscriber_1.Subscriber);
  var NotificationSubscriber = (function(_super) {
    __extends(NotificationSubscriber, _super);
    function NotificationSubscriber(parent) {
      _super.call(this, null);
      this.parent = parent;
      this.hasValue = false;
      this.hasCompleted = false;
    }
    NotificationSubscriber.prototype._next = function(unused) {
      this.hasValue = true;
    };
    NotificationSubscriber.prototype._error = function(err) {
      this.parent.error(err);
      this.hasValue = true;
    };
    NotificationSubscriber.prototype._complete = function() {
      this.hasCompleted = true;
    };
    return NotificationSubscriber;
  })(Subscriber_1.Subscriber);
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("b7", ["8", "b6"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var skipUntil_1 = $__require('b6');
  Observable_1.Observable.prototype.skipUntil = skipUntil_1.skipUntil;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("b8", ["17", "e", "f"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var __extends = (this && this.__extends) || function(d, b) {
    for (var p in b)
      if (b.hasOwnProperty(p))
        d[p] = b[p];
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
  var Subscriber_1 = $__require('17');
  var tryCatch_1 = $__require('e');
  var errorObject_1 = $__require('f');
  function skipWhile(predicate) {
    return this.lift(new SkipWhileOperator(predicate));
  }
  exports.skipWhile = skipWhile;
  var SkipWhileOperator = (function() {
    function SkipWhileOperator(predicate) {
      this.predicate = predicate;
    }
    SkipWhileOperator.prototype.call = function(subscriber) {
      return new SkipWhileSubscriber(subscriber, this.predicate);
    };
    return SkipWhileOperator;
  })();
  var SkipWhileSubscriber = (function(_super) {
    __extends(SkipWhileSubscriber, _super);
    function SkipWhileSubscriber(destination, predicate) {
      _super.call(this, destination);
      this.predicate = predicate;
      this.skipping = true;
      this.index = 0;
    }
    SkipWhileSubscriber.prototype._next = function(value) {
      var destination = this.destination;
      if (this.skipping === true) {
        var index = this.index++;
        var result = tryCatch_1.tryCatch(this.predicate)(value, index);
        if (result === errorObject_1.errorObject) {
          destination.error(result.e);
        } else {
          this.skipping = Boolean(result);
        }
      }
      if (this.skipping === false) {
        destination.next(value);
      }
    };
    return SkipWhileSubscriber;
  })(Subscriber_1.Subscriber);
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("b9", ["8", "b8"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var skipWhile_1 = $__require('b8');
  Observable_1.Observable.prototype.skipWhile = skipWhile_1.skipWhile;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("4e", ["49", "4a"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var __extends = (this && this.__extends) || function(d, b) {
    for (var p in b)
      if (b.hasOwnProperty(p))
        d[p] = b[p];
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
  var OuterSubscriber_1 = $__require('49');
  var subscribeToResult_1 = $__require('4a');
  var MergeAllOperator = (function() {
    function MergeAllOperator(concurrent) {
      this.concurrent = concurrent;
    }
    MergeAllOperator.prototype.call = function(observer) {
      return new MergeAllSubscriber(observer, this.concurrent);
    };
    return MergeAllOperator;
  })();
  exports.MergeAllOperator = MergeAllOperator;
  var MergeAllSubscriber = (function(_super) {
    __extends(MergeAllSubscriber, _super);
    function MergeAllSubscriber(destination, concurrent) {
      _super.call(this, destination);
      this.concurrent = concurrent;
      this.hasCompleted = false;
      this.buffer = [];
      this.active = 0;
    }
    MergeAllSubscriber.prototype._next = function(observable) {
      if (this.active < this.concurrent) {
        if (observable._isScalar) {
          this.destination.next(observable.value);
        } else {
          this.active++;
          this.add(subscribeToResult_1.subscribeToResult(this, observable));
        }
      } else {
        this.buffer.push(observable);
      }
    };
    MergeAllSubscriber.prototype._complete = function() {
      this.hasCompleted = true;
      if (this.active === 0 && this.buffer.length === 0) {
        this.destination.complete();
      }
    };
    MergeAllSubscriber.prototype.notifyComplete = function(innerSub) {
      var buffer = this.buffer;
      this.remove(innerSub);
      this.active--;
      if (buffer.length > 0) {
        this._next(buffer.shift());
      } else if (this.active === 0 && this.hasCompleted) {
        this.destination.complete();
      }
    };
    return MergeAllSubscriber;
  })(OuterSubscriber_1.OuterSubscriber);
  exports.MergeAllSubscriber = MergeAllSubscriber;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("a", ["20", "4e", "3", "5"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var queue_1 = $__require('20');
  var mergeAll_support_1 = $__require('4e');
  var fromArray_1 = $__require('3');
  var isScheduler_1 = $__require('5');
  function concat() {
    var observables = [];
    for (var _i = 0; _i < arguments.length; _i++) {
      observables[_i - 0] = arguments[_i];
    }
    var scheduler = queue_1.queue;
    var args = observables;
    if (isScheduler_1.isScheduler(args[observables.length - 1])) {
      scheduler = args.pop();
    }
    return new fromArray_1.ArrayObservable(observables, scheduler).lift(new mergeAll_support_1.MergeAllOperator(1));
  }
  exports.concat = concat;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("ba", ["3", "7d", "15", "a", "5"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var fromArray_1 = $__require('3');
  var ScalarObservable_1 = $__require('7d');
  var empty_1 = $__require('15');
  var concat_static_1 = $__require('a');
  var isScheduler_1 = $__require('5');
  function startWith() {
    var array = [];
    for (var _i = 0; _i < arguments.length; _i++) {
      array[_i - 0] = arguments[_i];
    }
    var scheduler = array[array.length - 1];
    if (isScheduler_1.isScheduler(scheduler)) {
      array.pop();
    } else {
      scheduler = void 0;
    }
    var len = array.length;
    if (len === 1) {
      return concat_static_1.concat(new ScalarObservable_1.ScalarObservable(array[0], scheduler), this);
    } else if (len > 1) {
      return concat_static_1.concat(new fromArray_1.ArrayObservable(array, scheduler), this);
    } else {
      return concat_static_1.concat(new empty_1.EmptyObservable(scheduler), this);
    }
  }
  exports.startWith = startWith;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("bb", ["8", "ba"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var startWith_1 = $__require('ba');
  Observable_1.Observable.prototype.startWith = startWith_1.startWith;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("2a", [], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var is_array = Array.isArray;
  function isNumeric(val) {
    return !is_array(val) && (val - parseFloat(val) + 1) >= 0;
  }
  exports.isNumeric = isNumeric;
  ;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("bc", ["8", "2b", "2a"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var __extends = (this && this.__extends) || function(d, b) {
    for (var p in b)
      if (b.hasOwnProperty(p))
        d[p] = b[p];
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
  var Observable_1 = $__require('8');
  var asap_1 = $__require('2b');
  var isNumeric_1 = $__require('2a');
  var SubscribeOnObservable = (function(_super) {
    __extends(SubscribeOnObservable, _super);
    function SubscribeOnObservable(source, delayTime, scheduler) {
      if (delayTime === void 0) {
        delayTime = 0;
      }
      if (scheduler === void 0) {
        scheduler = asap_1.asap;
      }
      _super.call(this);
      this.source = source;
      this.delayTime = delayTime;
      this.scheduler = scheduler;
      if (!isNumeric_1.isNumeric(delayTime) || delayTime < 0) {
        this.delayTime = 0;
      }
      if (!scheduler || typeof scheduler.schedule !== 'function') {
        this.scheduler = asap_1.asap;
      }
    }
    SubscribeOnObservable.create = function(source, delay, scheduler) {
      if (delay === void 0) {
        delay = 0;
      }
      if (scheduler === void 0) {
        scheduler = asap_1.asap;
      }
      return new SubscribeOnObservable(source, delay, scheduler);
    };
    SubscribeOnObservable.dispatch = function(_a) {
      var source = _a.source,
          subscriber = _a.subscriber;
      return source.subscribe(subscriber);
    };
    SubscribeOnObservable.prototype._subscribe = function(subscriber) {
      var delay = this.delayTime;
      var source = this.source;
      var scheduler = this.scheduler;
      subscriber.add(scheduler.schedule(SubscribeOnObservable.dispatch, delay, {
        source: source,
        subscriber: subscriber
      }));
    };
    return SubscribeOnObservable;
  })(Observable_1.Observable);
  exports.SubscribeOnObservable = SubscribeOnObservable;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("bd", ["bc"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var SubscribeOnObservable_1 = $__require('bc');
  function subscribeOn(scheduler, delay) {
    if (delay === void 0) {
      delay = 0;
    }
    return new SubscribeOnObservable_1.SubscribeOnObservable(this, delay, scheduler);
  }
  exports.subscribeOn = subscribeOn;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("be", ["8", "bd"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var subscribeOn_1 = $__require('bd');
  Observable_1.Observable.prototype.subscribeOn = subscribeOn_1.subscribeOn;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("bf", ["49", "4a"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var __extends = (this && this.__extends) || function(d, b) {
    for (var p in b)
      if (b.hasOwnProperty(p))
        d[p] = b[p];
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
  var OuterSubscriber_1 = $__require('49');
  var subscribeToResult_1 = $__require('4a');
  function _switch() {
    return this.lift(new SwitchOperator());
  }
  exports._switch = _switch;
  var SwitchOperator = (function() {
    function SwitchOperator() {}
    SwitchOperator.prototype.call = function(subscriber) {
      return new SwitchSubscriber(subscriber);
    };
    return SwitchOperator;
  })();
  var SwitchSubscriber = (function(_super) {
    __extends(SwitchSubscriber, _super);
    function SwitchSubscriber(destination) {
      _super.call(this, destination);
      this.active = 0;
      this.hasCompleted = false;
    }
    SwitchSubscriber.prototype._next = function(value) {
      this.unsubscribeInner();
      this.active++;
      this.add(this.innerSubscription = subscribeToResult_1.subscribeToResult(this, value));
    };
    SwitchSubscriber.prototype._complete = function() {
      this.hasCompleted = true;
      if (this.active === 0) {
        this.destination.complete();
      }
    };
    SwitchSubscriber.prototype.unsubscribeInner = function() {
      this.active = this.active > 0 ? this.active - 1 : 0;
      var innerSubscription = this.innerSubscription;
      if (innerSubscription) {
        innerSubscription.unsubscribe();
        this.remove(innerSubscription);
      }
    };
    SwitchSubscriber.prototype.notifyNext = function(outerValue, innerValue) {
      this.destination.next(innerValue);
    };
    SwitchSubscriber.prototype.notifyError = function(err) {
      this.destination.error(err);
    };
    SwitchSubscriber.prototype.notifyComplete = function() {
      this.unsubscribeInner();
      if (this.hasCompleted && this.active === 0) {
        this.destination.complete();
      }
    };
    return SwitchSubscriber;
  })(OuterSubscriber_1.OuterSubscriber);
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("c0", ["8", "bf"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var switch_1 = $__require('bf');
  Observable_1.Observable.prototype.switch = switch_1._switch;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("c1", ["e", "f", "49", "4a"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var __extends = (this && this.__extends) || function(d, b) {
    for (var p in b)
      if (b.hasOwnProperty(p))
        d[p] = b[p];
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
  var tryCatch_1 = $__require('e');
  var errorObject_1 = $__require('f');
  var OuterSubscriber_1 = $__require('49');
  var subscribeToResult_1 = $__require('4a');
  function switchMap(project, resultSelector) {
    return this.lift(new SwitchMapOperator(project, resultSelector));
  }
  exports.switchMap = switchMap;
  var SwitchMapOperator = (function() {
    function SwitchMapOperator(project, resultSelector) {
      this.project = project;
      this.resultSelector = resultSelector;
    }
    SwitchMapOperator.prototype.call = function(subscriber) {
      return new SwitchMapSubscriber(subscriber, this.project, this.resultSelector);
    };
    return SwitchMapOperator;
  })();
  var SwitchMapSubscriber = (function(_super) {
    __extends(SwitchMapSubscriber, _super);
    function SwitchMapSubscriber(destination, project, resultSelector) {
      _super.call(this, destination);
      this.project = project;
      this.resultSelector = resultSelector;
      this.hasCompleted = false;
      this.index = 0;
    }
    SwitchMapSubscriber.prototype._next = function(value) {
      var index = this.index++;
      var destination = this.destination;
      var result = tryCatch_1.tryCatch(this.project)(value, index);
      if (result === errorObject_1.errorObject) {
        destination.error(result.e);
      } else {
        var innerSubscription = this.innerSubscription;
        if (innerSubscription) {
          innerSubscription.unsubscribe();
        }
        this.add(this.innerSubscription = subscribeToResult_1.subscribeToResult(this, result, value, index));
      }
    };
    SwitchMapSubscriber.prototype._complete = function() {
      var innerSubscription = this.innerSubscription;
      this.hasCompleted = true;
      if (!innerSubscription || innerSubscription.isUnsubscribed) {
        this.destination.complete();
      }
    };
    SwitchMapSubscriber.prototype.notifyComplete = function(innerSub) {
      this.remove(innerSub);
      var prevSubscription = this.innerSubscription;
      if (prevSubscription) {
        prevSubscription.unsubscribe();
      }
      this.innerSubscription = null;
      if (this.hasCompleted) {
        this.destination.complete();
      }
    };
    SwitchMapSubscriber.prototype.notifyError = function(err) {
      this.destination.error(err);
    };
    SwitchMapSubscriber.prototype.notifyNext = function(outerValue, innerValue, outerIndex, innerIndex) {
      var _a = this,
          resultSelector = _a.resultSelector,
          destination = _a.destination;
      if (resultSelector) {
        var result = tryCatch_1.tryCatch(resultSelector)(outerValue, innerValue, outerIndex, innerIndex);
        if (result === errorObject_1.errorObject) {
          destination.error(errorObject_1.errorObject.e);
        } else {
          destination.next(result);
        }
      } else {
        destination.next(innerValue);
      }
    };
    return SwitchMapSubscriber;
  })(OuterSubscriber_1.OuterSubscriber);
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("c2", ["8", "c1"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var switchMap_1 = $__require('c1');
  Observable_1.Observable.prototype.switchMap = switchMap_1.switchMap;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("c3", ["e", "f", "49", "4a"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var __extends = (this && this.__extends) || function(d, b) {
    for (var p in b)
      if (b.hasOwnProperty(p))
        d[p] = b[p];
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
  var tryCatch_1 = $__require('e');
  var errorObject_1 = $__require('f');
  var OuterSubscriber_1 = $__require('49');
  var subscribeToResult_1 = $__require('4a');
  function switchMapTo(observable, projectResult) {
    return this.lift(new SwitchMapToOperator(observable, projectResult));
  }
  exports.switchMapTo = switchMapTo;
  var SwitchMapToOperator = (function() {
    function SwitchMapToOperator(observable, resultSelector) {
      this.observable = observable;
      this.resultSelector = resultSelector;
    }
    SwitchMapToOperator.prototype.call = function(subscriber) {
      return new SwitchMapToSubscriber(subscriber, this.observable, this.resultSelector);
    };
    return SwitchMapToOperator;
  })();
  var SwitchMapToSubscriber = (function(_super) {
    __extends(SwitchMapToSubscriber, _super);
    function SwitchMapToSubscriber(destination, inner, resultSelector) {
      _super.call(this, destination);
      this.inner = inner;
      this.resultSelector = resultSelector;
      this.hasCompleted = false;
      this.index = 0;
    }
    SwitchMapToSubscriber.prototype._next = function(value) {
      var index = this.index++;
      var innerSubscription = this.innerSubscription;
      if (innerSubscription) {
        innerSubscription.unsubscribe();
      }
      this.add(this.innerSubscription = subscribeToResult_1.subscribeToResult(this, this.inner, value, index));
    };
    SwitchMapToSubscriber.prototype._complete = function() {
      var innerSubscription = this.innerSubscription;
      this.hasCompleted = true;
      if (!innerSubscription || innerSubscription.isUnsubscribed) {
        this.destination.complete();
      }
    };
    SwitchMapToSubscriber.prototype.notifyComplete = function(innerSub) {
      this.remove(innerSub);
      var prevSubscription = this.innerSubscription;
      if (prevSubscription) {
        prevSubscription.unsubscribe();
      }
      this.innerSubscription = null;
      if (this.hasCompleted) {
        this.destination.complete();
      }
    };
    SwitchMapToSubscriber.prototype.notifyError = function(err) {
      this.destination.error(err);
    };
    SwitchMapToSubscriber.prototype.notifyNext = function(outerValue, innerValue, outerIndex, innerIndex) {
      var _a = this,
          resultSelector = _a.resultSelector,
          destination = _a.destination;
      if (resultSelector) {
        var result = tryCatch_1.tryCatch(resultSelector)(outerValue, innerValue, outerIndex, innerIndex);
        if (result === errorObject_1.errorObject) {
          destination.error(errorObject_1.errorObject.e);
        } else {
          destination.next(result);
        }
      } else {
        destination.next(innerValue);
      }
    };
    return SwitchMapToSubscriber;
  })(OuterSubscriber_1.OuterSubscriber);
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("c4", ["8", "c3"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var switchMapTo_1 = $__require('c3');
  Observable_1.Observable.prototype.switchMapTo = switchMapTo_1.switchMapTo;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("c5", ["17", "c6", "15"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var __extends = (this && this.__extends) || function(d, b) {
    for (var p in b)
      if (b.hasOwnProperty(p))
        d[p] = b[p];
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
  var Subscriber_1 = $__require('17');
  var ArgumentOutOfRangeError_1 = $__require('c6');
  var empty_1 = $__require('15');
  function take(total) {
    if (total === 0) {
      return new empty_1.EmptyObservable();
    } else {
      return this.lift(new TakeOperator(total));
    }
  }
  exports.take = take;
  var TakeOperator = (function() {
    function TakeOperator(total) {
      this.total = total;
      if (this.total < 0) {
        throw new ArgumentOutOfRangeError_1.ArgumentOutOfRangeError;
      }
    }
    TakeOperator.prototype.call = function(subscriber) {
      return new TakeSubscriber(subscriber, this.total);
    };
    return TakeOperator;
  })();
  var TakeSubscriber = (function(_super) {
    __extends(TakeSubscriber, _super);
    function TakeSubscriber(destination, total) {
      _super.call(this, destination);
      this.total = total;
      this.count = 0;
    }
    TakeSubscriber.prototype._next = function(value) {
      var total = this.total;
      if (++this.count <= total) {
        this.destination.next(value);
        if (this.count === total) {
          this.destination.complete();
        }
      }
    };
    return TakeSubscriber;
  })(Subscriber_1.Subscriber);
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("c7", ["8", "c5"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var take_1 = $__require('c5');
  Observable_1.Observable.prototype.take = take_1.take;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("c8", ["17", "2e"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var __extends = (this && this.__extends) || function(d, b) {
    for (var p in b)
      if (b.hasOwnProperty(p))
        d[p] = b[p];
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
  var Subscriber_1 = $__require('17');
  var noop_1 = $__require('2e');
  function takeUntil(notifier) {
    return this.lift(new TakeUntilOperator(notifier));
  }
  exports.takeUntil = takeUntil;
  var TakeUntilOperator = (function() {
    function TakeUntilOperator(notifier) {
      this.notifier = notifier;
    }
    TakeUntilOperator.prototype.call = function(subscriber) {
      return new TakeUntilSubscriber(subscriber, this.notifier);
    };
    return TakeUntilOperator;
  })();
  var TakeUntilSubscriber = (function(_super) {
    __extends(TakeUntilSubscriber, _super);
    function TakeUntilSubscriber(destination, notifier) {
      _super.call(this, destination);
      this.notifier = notifier;
      this.notificationSubscriber = null;
      this.notificationSubscriber = new TakeUntilInnerSubscriber(destination);
      this.add(notifier.subscribe(this.notificationSubscriber));
    }
    TakeUntilSubscriber.prototype._complete = function() {
      this.destination.complete();
      this.notificationSubscriber.unsubscribe();
    };
    return TakeUntilSubscriber;
  })(Subscriber_1.Subscriber);
  var TakeUntilInnerSubscriber = (function(_super) {
    __extends(TakeUntilInnerSubscriber, _super);
    function TakeUntilInnerSubscriber(destination) {
      _super.call(this, null);
      this.destination = destination;
    }
    TakeUntilInnerSubscriber.prototype._next = function(unused) {
      this.destination.complete();
    };
    TakeUntilInnerSubscriber.prototype._error = function(err) {
      this.destination.error(err);
    };
    TakeUntilInnerSubscriber.prototype._complete = function() {
      noop_1.noop();
    };
    return TakeUntilInnerSubscriber;
  })(Subscriber_1.Subscriber);
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("c9", ["8", "c8"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var takeUntil_1 = $__require('c8');
  Observable_1.Observable.prototype.takeUntil = takeUntil_1.takeUntil;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("ca", ["17", "e", "f"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var __extends = (this && this.__extends) || function(d, b) {
    for (var p in b)
      if (b.hasOwnProperty(p))
        d[p] = b[p];
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
  var Subscriber_1 = $__require('17');
  var tryCatch_1 = $__require('e');
  var errorObject_1 = $__require('f');
  function takeWhile(predicate) {
    return this.lift(new TakeWhileOperator(predicate));
  }
  exports.takeWhile = takeWhile;
  var TakeWhileOperator = (function() {
    function TakeWhileOperator(predicate) {
      this.predicate = predicate;
    }
    TakeWhileOperator.prototype.call = function(subscriber) {
      return new TakeWhileSubscriber(subscriber, this.predicate);
    };
    return TakeWhileOperator;
  })();
  var TakeWhileSubscriber = (function(_super) {
    __extends(TakeWhileSubscriber, _super);
    function TakeWhileSubscriber(destination, predicate) {
      _super.call(this, destination);
      this.predicate = predicate;
      this.index = 0;
    }
    TakeWhileSubscriber.prototype._next = function(value) {
      var destination = this.destination;
      var result = tryCatch_1.tryCatch(this.predicate)(value, this.index++);
      if (result == errorObject_1.errorObject) {
        destination.error(result.e);
      } else if (Boolean(result)) {
        destination.next(value);
      } else {
        destination.complete();
      }
    };
    return TakeWhileSubscriber;
  })(Subscriber_1.Subscriber);
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("cb", ["8", "ca"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var takeWhile_1 = $__require('ca');
  Observable_1.Observable.prototype.takeWhile = takeWhile_1.takeWhile;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("18", ["8", "24", "20"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var __extends = (this && this.__extends) || function(d, b) {
    for (var p in b)
      if (b.hasOwnProperty(p))
        d[p] = b[p];
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
  var Observable_1 = $__require('8');
  var Subscription_1 = $__require('24');
  var queue_1 = $__require('20');
  var PromiseObservable = (function(_super) {
    __extends(PromiseObservable, _super);
    function PromiseObservable(promise, scheduler) {
      if (scheduler === void 0) {
        scheduler = queue_1.queue;
      }
      _super.call(this);
      this.promise = promise;
      this.scheduler = scheduler;
      this._isScalar = false;
    }
    PromiseObservable.create = function(promise, scheduler) {
      if (scheduler === void 0) {
        scheduler = queue_1.queue;
      }
      return new PromiseObservable(promise, scheduler);
    };
    PromiseObservable.prototype._subscribe = function(subscriber) {
      var _this = this;
      var scheduler = this.scheduler;
      var promise = this.promise;
      if (scheduler === queue_1.queue) {
        if (this._isScalar) {
          subscriber.next(this.value);
          subscriber.complete();
        } else {
          promise.then(function(value) {
            _this._isScalar = true;
            _this.value = value;
            subscriber.next(value);
            subscriber.complete();
          }, function(err) {
            return subscriber.error(err);
          }).then(null, function(err) {
            setTimeout(function() {
              throw err;
            });
          });
        }
      } else {
        var subscription = new Subscription_1.Subscription();
        if (this._isScalar) {
          var value = this.value;
          subscription.add(scheduler.schedule(dispatchNext, 0, {
            value: value,
            subscriber: subscriber
          }));
        } else {
          promise.then(function(value) {
            _this._isScalar = true;
            _this.value = value;
            subscription.add(scheduler.schedule(dispatchNext, 0, {
              value: value,
              subscriber: subscriber
            }));
          }, function(err) {
            return subscription.add(scheduler.schedule(dispatchError, 0, {
              err: err,
              subscriber: subscriber
            }));
          }).then(null, function(err) {
            scheduler.schedule(function() {
              throw err;
            });
          });
        }
        return subscription;
      }
    };
    return PromiseObservable;
  })(Observable_1.Observable);
  exports.PromiseObservable = PromiseObservable;
  function dispatchNext(_a) {
    var value = _a.value,
        subscriber = _a.subscriber;
    subscriber.next(value);
    subscriber.complete();
  }
  function dispatchError(_a) {
    var err = _a.err,
        subscriber = _a.subscriber;
    subscriber.error(err);
  }
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("19", [], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  function isPromise(value) {
    return value && typeof value.subscribe !== 'function' && typeof value.then === 'function';
  }
  exports.isPromise = isPromise;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("cc", ["18", "17", "e", "19", "f"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var __extends = (this && this.__extends) || function(d, b) {
    for (var p in b)
      if (b.hasOwnProperty(p))
        d[p] = b[p];
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
  var fromPromise_1 = $__require('18');
  var Subscriber_1 = $__require('17');
  var tryCatch_1 = $__require('e');
  var isPromise_1 = $__require('19');
  var errorObject_1 = $__require('f');
  function throttle(durationSelector) {
    return this.lift(new ThrottleOperator(durationSelector));
  }
  exports.throttle = throttle;
  var ThrottleOperator = (function() {
    function ThrottleOperator(durationSelector) {
      this.durationSelector = durationSelector;
    }
    ThrottleOperator.prototype.call = function(subscriber) {
      return new ThrottleSubscriber(subscriber, this.durationSelector);
    };
    return ThrottleOperator;
  })();
  var ThrottleSubscriber = (function(_super) {
    __extends(ThrottleSubscriber, _super);
    function ThrottleSubscriber(destination, durationSelector) {
      _super.call(this, destination);
      this.durationSelector = durationSelector;
    }
    ThrottleSubscriber.prototype._next = function(value) {
      if (!this.throttled) {
        var destination = this.destination;
        var duration = tryCatch_1.tryCatch(this.durationSelector)(value);
        if (duration === errorObject_1.errorObject) {
          destination.error(errorObject_1.errorObject.e);
          return;
        }
        if (isPromise_1.isPromise(duration)) {
          duration = fromPromise_1.PromiseObservable.create(duration);
        }
        this.add(this.throttled = duration._subscribe(new ThrottleDurationSelectorSubscriber(this)));
        destination.next(value);
      }
    };
    ThrottleSubscriber.prototype._error = function(err) {
      this.clearThrottle();
      _super.prototype._error.call(this, err);
    };
    ThrottleSubscriber.prototype._complete = function() {
      this.clearThrottle();
      _super.prototype._complete.call(this);
    };
    ThrottleSubscriber.prototype.clearThrottle = function() {
      var throttled = this.throttled;
      if (throttled) {
        throttled.unsubscribe();
        this.remove(throttled);
        this.throttled = null;
      }
    };
    return ThrottleSubscriber;
  })(Subscriber_1.Subscriber);
  var ThrottleDurationSelectorSubscriber = (function(_super) {
    __extends(ThrottleDurationSelectorSubscriber, _super);
    function ThrottleDurationSelectorSubscriber(parent) {
      _super.call(this, null);
      this.parent = parent;
    }
    ThrottleDurationSelectorSubscriber.prototype._next = function(unused) {
      this.parent.clearThrottle();
    };
    ThrottleDurationSelectorSubscriber.prototype._error = function(err) {
      this.parent.error(err);
    };
    ThrottleDurationSelectorSubscriber.prototype._complete = function() {
      this.parent.clearThrottle();
    };
    return ThrottleDurationSelectorSubscriber;
  })(Subscriber_1.Subscriber);
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("cd", ["8", "cc"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var throttle_1 = $__require('cc');
  Observable_1.Observable.prototype.throttle = throttle_1.throttle;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("ce", ["17", "2b"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var __extends = (this && this.__extends) || function(d, b) {
    for (var p in b)
      if (b.hasOwnProperty(p))
        d[p] = b[p];
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
  var Subscriber_1 = $__require('17');
  var asap_1 = $__require('2b');
  function throttleTime(delay, scheduler) {
    if (scheduler === void 0) {
      scheduler = asap_1.asap;
    }
    return this.lift(new ThrottleTimeOperator(delay, scheduler));
  }
  exports.throttleTime = throttleTime;
  var ThrottleTimeOperator = (function() {
    function ThrottleTimeOperator(delay, scheduler) {
      this.delay = delay;
      this.scheduler = scheduler;
    }
    ThrottleTimeOperator.prototype.call = function(subscriber) {
      return new ThrottleTimeSubscriber(subscriber, this.delay, this.scheduler);
    };
    return ThrottleTimeOperator;
  })();
  var ThrottleTimeSubscriber = (function(_super) {
    __extends(ThrottleTimeSubscriber, _super);
    function ThrottleTimeSubscriber(destination, delay, scheduler) {
      _super.call(this, destination);
      this.delay = delay;
      this.scheduler = scheduler;
    }
    ThrottleTimeSubscriber.prototype._next = function(value) {
      if (!this.throttled) {
        this.add(this.throttled = this.scheduler.schedule(dispatchNext, this.delay, {subscriber: this}));
        this.destination.next(value);
      }
    };
    ThrottleTimeSubscriber.prototype.clearThrottle = function() {
      var throttled = this.throttled;
      if (throttled) {
        throttled.unsubscribe();
        this.remove(throttled);
        this.throttled = null;
      }
    };
    return ThrottleTimeSubscriber;
  })(Subscriber_1.Subscriber);
  function dispatchNext(_a) {
    var subscriber = _a.subscriber;
    subscriber.clearThrottle();
  }
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("cf", ["8", "ce"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var throttleTime_1 = $__require('ce');
  Observable_1.Observable.prototype.throttleTime = throttleTime_1.throttleTime;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("d0", ["17", "20", "35"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var __extends = (this && this.__extends) || function(d, b) {
    for (var p in b)
      if (b.hasOwnProperty(p))
        d[p] = b[p];
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
  var Subscriber_1 = $__require('17');
  var queue_1 = $__require('20');
  var isDate_1 = $__require('35');
  function timeout(due, errorToSend, scheduler) {
    if (errorToSend === void 0) {
      errorToSend = null;
    }
    if (scheduler === void 0) {
      scheduler = queue_1.queue;
    }
    var absoluteTimeout = isDate_1.isDate(due);
    var waitFor = absoluteTimeout ? (+due - scheduler.now()) : due;
    return this.lift(new TimeoutOperator(waitFor, absoluteTimeout, errorToSend, scheduler));
  }
  exports.timeout = timeout;
  var TimeoutOperator = (function() {
    function TimeoutOperator(waitFor, absoluteTimeout, errorToSend, scheduler) {
      this.waitFor = waitFor;
      this.absoluteTimeout = absoluteTimeout;
      this.errorToSend = errorToSend;
      this.scheduler = scheduler;
    }
    TimeoutOperator.prototype.call = function(subscriber) {
      return new TimeoutSubscriber(subscriber, this.absoluteTimeout, this.waitFor, this.errorToSend, this.scheduler);
    };
    return TimeoutOperator;
  })();
  var TimeoutSubscriber = (function(_super) {
    __extends(TimeoutSubscriber, _super);
    function TimeoutSubscriber(destination, absoluteTimeout, waitFor, errorToSend, scheduler) {
      _super.call(this, destination);
      this.absoluteTimeout = absoluteTimeout;
      this.waitFor = waitFor;
      this.errorToSend = errorToSend;
      this.scheduler = scheduler;
      this.index = 0;
      this._previousIndex = 0;
      this._hasCompleted = false;
      this.scheduleTimeout();
    }
    Object.defineProperty(TimeoutSubscriber.prototype, "previousIndex", {
      get: function() {
        return this._previousIndex;
      },
      enumerable: true,
      configurable: true
    });
    Object.defineProperty(TimeoutSubscriber.prototype, "hasCompleted", {
      get: function() {
        return this._hasCompleted;
      },
      enumerable: true,
      configurable: true
    });
    TimeoutSubscriber.dispatchTimeout = function(state) {
      var source = state.subscriber;
      var currentIndex = state.index;
      if (!source.hasCompleted && source.previousIndex === currentIndex) {
        source.notifyTimeout();
      }
    };
    TimeoutSubscriber.prototype.scheduleTimeout = function() {
      var currentIndex = this.index;
      this.scheduler.schedule(TimeoutSubscriber.dispatchTimeout, this.waitFor, {
        subscriber: this,
        index: currentIndex
      });
      this.index++;
      this._previousIndex = currentIndex;
    };
    TimeoutSubscriber.prototype._next = function(value) {
      this.destination.next(value);
      if (!this.absoluteTimeout) {
        this.scheduleTimeout();
      }
    };
    TimeoutSubscriber.prototype._error = function(err) {
      this.destination.error(err);
      this._hasCompleted = true;
    };
    TimeoutSubscriber.prototype._complete = function() {
      this.destination.complete();
      this._hasCompleted = true;
    };
    TimeoutSubscriber.prototype.notifyTimeout = function() {
      this.error(this.errorToSend || new Error('timeout'));
    };
    return TimeoutSubscriber;
  })(Subscriber_1.Subscriber);
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("d1", ["8", "d0"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var timeout_1 = $__require('d0');
  Observable_1.Observable.prototype.timeout = timeout_1.timeout;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("35", [], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  function isDate(value) {
    return value instanceof Date && !isNaN(+value);
  }
  exports.isDate = isDate;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("d2", ["20", "35", "49", "4a"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var __extends = (this && this.__extends) || function(d, b) {
    for (var p in b)
      if (b.hasOwnProperty(p))
        d[p] = b[p];
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
  var queue_1 = $__require('20');
  var isDate_1 = $__require('35');
  var OuterSubscriber_1 = $__require('49');
  var subscribeToResult_1 = $__require('4a');
  function timeoutWith(due, withObservable, scheduler) {
    if (scheduler === void 0) {
      scheduler = queue_1.queue;
    }
    var absoluteTimeout = isDate_1.isDate(due);
    var waitFor = absoluteTimeout ? (+due - scheduler.now()) : due;
    return this.lift(new TimeoutWithOperator(waitFor, absoluteTimeout, withObservable, scheduler));
  }
  exports.timeoutWith = timeoutWith;
  var TimeoutWithOperator = (function() {
    function TimeoutWithOperator(waitFor, absoluteTimeout, withObservable, scheduler) {
      this.waitFor = waitFor;
      this.absoluteTimeout = absoluteTimeout;
      this.withObservable = withObservable;
      this.scheduler = scheduler;
    }
    TimeoutWithOperator.prototype.call = function(subscriber) {
      return new TimeoutWithSubscriber(subscriber, this.absoluteTimeout, this.waitFor, this.withObservable, this.scheduler);
    };
    return TimeoutWithOperator;
  })();
  var TimeoutWithSubscriber = (function(_super) {
    __extends(TimeoutWithSubscriber, _super);
    function TimeoutWithSubscriber(destination, absoluteTimeout, waitFor, withObservable, scheduler) {
      _super.call(this, null);
      this.destination = destination;
      this.absoluteTimeout = absoluteTimeout;
      this.waitFor = waitFor;
      this.withObservable = withObservable;
      this.scheduler = scheduler;
      this.timeoutSubscription = undefined;
      this.index = 0;
      this._previousIndex = 0;
      this._hasCompleted = false;
      destination.add(this);
      this.scheduleTimeout();
    }
    Object.defineProperty(TimeoutWithSubscriber.prototype, "previousIndex", {
      get: function() {
        return this._previousIndex;
      },
      enumerable: true,
      configurable: true
    });
    Object.defineProperty(TimeoutWithSubscriber.prototype, "hasCompleted", {
      get: function() {
        return this._hasCompleted;
      },
      enumerable: true,
      configurable: true
    });
    TimeoutWithSubscriber.dispatchTimeout = function(state) {
      var source = state.subscriber;
      var currentIndex = state.index;
      if (!source.hasCompleted && source.previousIndex === currentIndex) {
        source.handleTimeout();
      }
    };
    TimeoutWithSubscriber.prototype.scheduleTimeout = function() {
      var currentIndex = this.index;
      var timeoutState = {
        subscriber: this,
        index: currentIndex
      };
      this.scheduler.schedule(TimeoutWithSubscriber.dispatchTimeout, this.waitFor, timeoutState);
      this.index++;
      this._previousIndex = currentIndex;
    };
    TimeoutWithSubscriber.prototype._next = function(value) {
      this.destination.next(value);
      if (!this.absoluteTimeout) {
        this.scheduleTimeout();
      }
    };
    TimeoutWithSubscriber.prototype._error = function(err) {
      this.destination.error(err);
      this._hasCompleted = true;
    };
    TimeoutWithSubscriber.prototype._complete = function() {
      this.destination.complete();
      this._hasCompleted = true;
    };
    TimeoutWithSubscriber.prototype.handleTimeout = function() {
      if (!this.isUnsubscribed) {
        var withObservable = this.withObservable;
        this.unsubscribe();
        this.destination.add(this.timeoutSubscription = subscribeToResult_1.subscribeToResult(this, withObservable));
      }
    };
    return TimeoutWithSubscriber;
  })(OuterSubscriber_1.OuterSubscriber);
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("d3", ["8", "d2"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var timeoutWith_1 = $__require('d2');
  Observable_1.Observable.prototype.timeoutWith = timeoutWith_1.timeoutWith;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("d4", ["17"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var __extends = (this && this.__extends) || function(d, b) {
    for (var p in b)
      if (b.hasOwnProperty(p))
        d[p] = b[p];
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
  var Subscriber_1 = $__require('17');
  function toArray() {
    return this.lift(new ToArrayOperator());
  }
  exports.toArray = toArray;
  var ToArrayOperator = (function() {
    function ToArrayOperator() {}
    ToArrayOperator.prototype.call = function(subscriber) {
      return new ToArraySubscriber(subscriber);
    };
    return ToArrayOperator;
  })();
  var ToArraySubscriber = (function(_super) {
    __extends(ToArraySubscriber, _super);
    function ToArraySubscriber(destination) {
      _super.call(this, destination);
      this.array = [];
    }
    ToArraySubscriber.prototype._next = function(x) {
      this.array.push(x);
    };
    ToArraySubscriber.prototype._complete = function() {
      this.destination.next(this.array);
      this.destination.complete();
    };
    return ToArraySubscriber;
  })(Subscriber_1.Subscriber);
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("d5", ["8", "d4"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var toArray_1 = $__require('d4');
  Observable_1.Observable.prototype.toArray = toArray_1.toArray;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("d6", ["1c"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var root_1 = $__require('1c');
  function toPromise(PromiseCtor) {
    var _this = this;
    if (!PromiseCtor) {
      if (root_1.root.Rx && root_1.root.Rx.config && root_1.root.Rx.config.Promise) {
        PromiseCtor = root_1.root.Rx.config.Promise;
      } else if (root_1.root.Promise) {
        PromiseCtor = root_1.root.Promise;
      }
    }
    if (!PromiseCtor) {
      throw new Error('no Promise impl found');
    }
    return new PromiseCtor(function(resolve, reject) {
      var value;
      _this.subscribe(function(x) {
        return value = x;
      }, function(err) {
        return reject(err);
      }, function() {
        return resolve(value);
      });
    });
  }
  exports.toPromise = toPromise;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("d7", ["8", "d6"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var toPromise_1 = $__require('d6');
  Observable_1.Observable.prototype.toPromise = toPromise_1.toPromise;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("d8", ["17", "78"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var __extends = (this && this.__extends) || function(d, b) {
    for (var p in b)
      if (b.hasOwnProperty(p))
        d[p] = b[p];
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
  var Subscriber_1 = $__require('17');
  var Subject_1 = $__require('78');
  function window(closingNotifier) {
    return this.lift(new WindowOperator(closingNotifier));
  }
  exports.window = window;
  var WindowOperator = (function() {
    function WindowOperator(closingNotifier) {
      this.closingNotifier = closingNotifier;
    }
    WindowOperator.prototype.call = function(subscriber) {
      return new WindowSubscriber(subscriber, this.closingNotifier);
    };
    return WindowOperator;
  })();
  var WindowSubscriber = (function(_super) {
    __extends(WindowSubscriber, _super);
    function WindowSubscriber(destination, closingNotifier) {
      _super.call(this, destination);
      this.destination = destination;
      this.closingNotifier = closingNotifier;
      this.add(closingNotifier._subscribe(new WindowClosingNotifierSubscriber(this)));
      this.openWindow();
    }
    WindowSubscriber.prototype._next = function(value) {
      this.window.next(value);
    };
    WindowSubscriber.prototype._error = function(err) {
      this.window.error(err);
      this.destination.error(err);
    };
    WindowSubscriber.prototype._complete = function() {
      this.window.complete();
      this.destination.complete();
    };
    WindowSubscriber.prototype.openWindow = function() {
      var prevWindow = this.window;
      if (prevWindow) {
        prevWindow.complete();
      }
      var destination = this.destination;
      var newWindow = this.window = new Subject_1.Subject();
      destination.add(newWindow);
      destination.next(newWindow);
    };
    return WindowSubscriber;
  })(Subscriber_1.Subscriber);
  var WindowClosingNotifierSubscriber = (function(_super) {
    __extends(WindowClosingNotifierSubscriber, _super);
    function WindowClosingNotifierSubscriber(parent) {
      _super.call(this, null);
      this.parent = parent;
    }
    WindowClosingNotifierSubscriber.prototype._next = function() {
      this.parent.openWindow();
    };
    WindowClosingNotifierSubscriber.prototype._error = function(err) {
      this.parent._error(err);
    };
    WindowClosingNotifierSubscriber.prototype._complete = function() {
      this.parent._complete();
    };
    return WindowClosingNotifierSubscriber;
  })(Subscriber_1.Subscriber);
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("d9", ["8", "d8"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var window_1 = $__require('d8');
  Observable_1.Observable.prototype.window = window_1.window;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("da", ["17", "78"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var __extends = (this && this.__extends) || function(d, b) {
    for (var p in b)
      if (b.hasOwnProperty(p))
        d[p] = b[p];
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
  var Subscriber_1 = $__require('17');
  var Subject_1 = $__require('78');
  function windowCount(windowSize, startWindowEvery) {
    if (startWindowEvery === void 0) {
      startWindowEvery = 0;
    }
    return this.lift(new WindowCountOperator(windowSize, startWindowEvery));
  }
  exports.windowCount = windowCount;
  var WindowCountOperator = (function() {
    function WindowCountOperator(windowSize, startWindowEvery) {
      this.windowSize = windowSize;
      this.startWindowEvery = startWindowEvery;
    }
    WindowCountOperator.prototype.call = function(subscriber) {
      return new WindowCountSubscriber(subscriber, this.windowSize, this.startWindowEvery);
    };
    return WindowCountOperator;
  })();
  var WindowCountSubscriber = (function(_super) {
    __extends(WindowCountSubscriber, _super);
    function WindowCountSubscriber(destination, windowSize, startWindowEvery) {
      _super.call(this, destination);
      this.destination = destination;
      this.windowSize = windowSize;
      this.startWindowEvery = startWindowEvery;
      this.windows = [new Subject_1.Subject()];
      this.count = 0;
      var firstWindow = this.windows[0];
      destination.add(firstWindow);
      destination.next(firstWindow);
    }
    WindowCountSubscriber.prototype._next = function(value) {
      var startWindowEvery = (this.startWindowEvery > 0) ? this.startWindowEvery : this.windowSize;
      var destination = this.destination;
      var windowSize = this.windowSize;
      var windows = this.windows;
      var len = windows.length;
      for (var i = 0; i < len; i++) {
        windows[i].next(value);
      }
      var c = this.count - windowSize + 1;
      if (c >= 0 && c % startWindowEvery === 0) {
        windows.shift().complete();
      }
      if (++this.count % startWindowEvery === 0) {
        var window_1 = new Subject_1.Subject();
        windows.push(window_1);
        destination.add(window_1);
        destination.next(window_1);
      }
    };
    WindowCountSubscriber.prototype._error = function(err) {
      var windows = this.windows;
      while (windows.length > 0) {
        windows.shift().error(err);
      }
      this.destination.error(err);
    };
    WindowCountSubscriber.prototype._complete = function() {
      var windows = this.windows;
      while (windows.length > 0) {
        windows.shift().complete();
      }
      this.destination.complete();
    };
    return WindowCountSubscriber;
  })(Subscriber_1.Subscriber);
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("db", ["8", "da"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var windowCount_1 = $__require('da');
  Observable_1.Observable.prototype.windowCount = windowCount_1.windowCount;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("dc", ["17", "78", "2b"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var __extends = (this && this.__extends) || function(d, b) {
    for (var p in b)
      if (b.hasOwnProperty(p))
        d[p] = b[p];
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
  var Subscriber_1 = $__require('17');
  var Subject_1 = $__require('78');
  var asap_1 = $__require('2b');
  function windowTime(windowTimeSpan, windowCreationInterval, scheduler) {
    if (windowCreationInterval === void 0) {
      windowCreationInterval = null;
    }
    if (scheduler === void 0) {
      scheduler = asap_1.asap;
    }
    return this.lift(new WindowTimeOperator(windowTimeSpan, windowCreationInterval, scheduler));
  }
  exports.windowTime = windowTime;
  var WindowTimeOperator = (function() {
    function WindowTimeOperator(windowTimeSpan, windowCreationInterval, scheduler) {
      this.windowTimeSpan = windowTimeSpan;
      this.windowCreationInterval = windowCreationInterval;
      this.scheduler = scheduler;
    }
    WindowTimeOperator.prototype.call = function(subscriber) {
      return new WindowTimeSubscriber(subscriber, this.windowTimeSpan, this.windowCreationInterval, this.scheduler);
    };
    return WindowTimeOperator;
  })();
  var WindowTimeSubscriber = (function(_super) {
    __extends(WindowTimeSubscriber, _super);
    function WindowTimeSubscriber(destination, windowTimeSpan, windowCreationInterval, scheduler) {
      _super.call(this, destination);
      this.destination = destination;
      this.windowTimeSpan = windowTimeSpan;
      this.windowCreationInterval = windowCreationInterval;
      this.scheduler = scheduler;
      this.windows = [];
      if (windowCreationInterval !== null && windowCreationInterval >= 0) {
        var window_1 = this.openWindow();
        var closeState = {
          subscriber: this,
          window: window_1,
          context: null
        };
        var creationState = {
          windowTimeSpan: windowTimeSpan,
          windowCreationInterval: windowCreationInterval,
          subscriber: this,
          scheduler: scheduler
        };
        this.add(scheduler.schedule(dispatchWindowClose, windowTimeSpan, closeState));
        this.add(scheduler.schedule(dispatchWindowCreation, windowCreationInterval, creationState));
      } else {
        var window_2 = this.openWindow();
        var timeSpanOnlyState = {
          subscriber: this,
          window: window_2,
          windowTimeSpan: windowTimeSpan
        };
        this.add(scheduler.schedule(dispatchWindowTimeSpanOnly, windowTimeSpan, timeSpanOnlyState));
      }
    }
    WindowTimeSubscriber.prototype._next = function(value) {
      var windows = this.windows;
      var len = windows.length;
      for (var i = 0; i < len; i++) {
        windows[i].next(value);
      }
    };
    WindowTimeSubscriber.prototype._error = function(err) {
      var windows = this.windows;
      while (windows.length > 0) {
        windows.shift().error(err);
      }
      this.destination.error(err);
    };
    WindowTimeSubscriber.prototype._complete = function() {
      var windows = this.windows;
      while (windows.length > 0) {
        windows.shift().complete();
      }
      this.destination.complete();
    };
    WindowTimeSubscriber.prototype.openWindow = function() {
      var window = new Subject_1.Subject();
      this.windows.push(window);
      var destination = this.destination;
      destination.add(window);
      destination.next(window);
      return window;
    };
    WindowTimeSubscriber.prototype.closeWindow = function(window) {
      window.complete();
      var windows = this.windows;
      windows.splice(windows.indexOf(window), 1);
    };
    return WindowTimeSubscriber;
  })(Subscriber_1.Subscriber);
  function dispatchWindowTimeSpanOnly(state) {
    var subscriber = state.subscriber,
        windowTimeSpan = state.windowTimeSpan,
        window = state.window;
    if (window) {
      window.complete();
    }
    state.window = subscriber.openWindow();
    this.schedule(state, windowTimeSpan);
  }
  function dispatchWindowCreation(state) {
    var windowTimeSpan = state.windowTimeSpan,
        subscriber = state.subscriber,
        scheduler = state.scheduler,
        windowCreationInterval = state.windowCreationInterval;
    var window = subscriber.openWindow();
    var action = this;
    var context = {
      action: action,
      subscription: null
    };
    var timeSpanState = {
      subscriber: subscriber,
      window: window,
      context: context
    };
    context.subscription = scheduler.schedule(dispatchWindowClose, windowTimeSpan, timeSpanState);
    action.add(context.subscription);
    action.schedule(state, windowCreationInterval);
  }
  function dispatchWindowClose(_a) {
    var subscriber = _a.subscriber,
        window = _a.window,
        context = _a.context;
    if (context && context.action && context.subscription) {
      context.action.remove(context.subscription);
    }
    subscriber.closeWindow(window);
  }
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("dd", ["8", "dc"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var windowTime_1 = $__require('dc');
  Observable_1.Observable.prototype.windowTime = windowTime_1.windowTime;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("de", ["17", "78", "24", "e", "f"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var __extends = (this && this.__extends) || function(d, b) {
    for (var p in b)
      if (b.hasOwnProperty(p))
        d[p] = b[p];
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
  var Subscriber_1 = $__require('17');
  var Subject_1 = $__require('78');
  var Subscription_1 = $__require('24');
  var tryCatch_1 = $__require('e');
  var errorObject_1 = $__require('f');
  function windowToggle(openings, closingSelector) {
    return this.lift(new WindowToggleOperator(openings, closingSelector));
  }
  exports.windowToggle = windowToggle;
  var WindowToggleOperator = (function() {
    function WindowToggleOperator(openings, closingSelector) {
      this.openings = openings;
      this.closingSelector = closingSelector;
    }
    WindowToggleOperator.prototype.call = function(subscriber) {
      return new WindowToggleSubscriber(subscriber, this.openings, this.closingSelector);
    };
    return WindowToggleOperator;
  })();
  var WindowToggleSubscriber = (function(_super) {
    __extends(WindowToggleSubscriber, _super);
    function WindowToggleSubscriber(destination, openings, closingSelector) {
      _super.call(this, destination);
      this.destination = destination;
      this.openings = openings;
      this.closingSelector = closingSelector;
      this.contexts = [];
      this.add(this.openings._subscribe(new WindowToggleOpeningsSubscriber(this)));
    }
    WindowToggleSubscriber.prototype._next = function(value) {
      var contexts = this.contexts;
      var len = contexts.length;
      for (var i = 0; i < len; i++) {
        contexts[i].window.next(value);
      }
    };
    WindowToggleSubscriber.prototype._error = function(err) {
      var contexts = this.contexts;
      while (contexts.length > 0) {
        contexts.shift().window.error(err);
      }
      this.destination.error(err);
    };
    WindowToggleSubscriber.prototype._complete = function() {
      var contexts = this.contexts;
      while (contexts.length > 0) {
        var context = contexts.shift();
        context.window.complete();
        context.subscription.unsubscribe();
      }
      this.destination.complete();
    };
    WindowToggleSubscriber.prototype.openWindow = function(value) {
      var closingSelector = this.closingSelector;
      var closingNotifier = tryCatch_1.tryCatch(closingSelector)(value);
      if (closingNotifier === errorObject_1.errorObject) {
        this.error(closingNotifier.e);
      } else {
        var destination = this.destination;
        var window_1 = new Subject_1.Subject();
        var subscription = new Subscription_1.Subscription();
        var context = {
          window: window_1,
          subscription: subscription
        };
        this.contexts.push(context);
        var subscriber = new WindowClosingNotifierSubscriber(this, context);
        var closingSubscription = closingNotifier._subscribe(subscriber);
        subscription.add(closingSubscription);
        destination.add(subscription);
        destination.add(window_1);
        destination.next(window_1);
      }
    };
    WindowToggleSubscriber.prototype.closeWindow = function(context) {
      var window = context.window,
          subscription = context.subscription;
      var contexts = this.contexts;
      var destination = this.destination;
      contexts.splice(contexts.indexOf(context), 1);
      window.complete();
      destination.remove(subscription);
      destination.remove(window);
      subscription.unsubscribe();
    };
    return WindowToggleSubscriber;
  })(Subscriber_1.Subscriber);
  var WindowClosingNotifierSubscriber = (function(_super) {
    __extends(WindowClosingNotifierSubscriber, _super);
    function WindowClosingNotifierSubscriber(parent, windowContext) {
      _super.call(this, null);
      this.parent = parent;
      this.windowContext = windowContext;
    }
    WindowClosingNotifierSubscriber.prototype._next = function() {
      this.parent.closeWindow(this.windowContext);
    };
    WindowClosingNotifierSubscriber.prototype._error = function(err) {
      this.parent.error(err);
    };
    WindowClosingNotifierSubscriber.prototype._complete = function() {
      this.parent.closeWindow(this.windowContext);
    };
    return WindowClosingNotifierSubscriber;
  })(Subscriber_1.Subscriber);
  var WindowToggleOpeningsSubscriber = (function(_super) {
    __extends(WindowToggleOpeningsSubscriber, _super);
    function WindowToggleOpeningsSubscriber(parent) {
      _super.call(this);
      this.parent = parent;
    }
    WindowToggleOpeningsSubscriber.prototype._next = function(value) {
      this.parent.openWindow(value);
    };
    WindowToggleOpeningsSubscriber.prototype._error = function(err) {
      this.parent.error(err);
    };
    WindowToggleOpeningsSubscriber.prototype._complete = function() {};
    return WindowToggleOpeningsSubscriber;
  })(Subscriber_1.Subscriber);
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("df", ["8", "de"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var windowToggle_1 = $__require('de');
  Observable_1.Observable.prototype.windowToggle = windowToggle_1.windowToggle;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("e0", ["17", "78", "24", "e", "f"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var __extends = (this && this.__extends) || function(d, b) {
    for (var p in b)
      if (b.hasOwnProperty(p))
        d[p] = b[p];
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
  var Subscriber_1 = $__require('17');
  var Subject_1 = $__require('78');
  var Subscription_1 = $__require('24');
  var tryCatch_1 = $__require('e');
  var errorObject_1 = $__require('f');
  function windowWhen(closingSelector) {
    return this.lift(new WindowOperator(closingSelector));
  }
  exports.windowWhen = windowWhen;
  var WindowOperator = (function() {
    function WindowOperator(closingSelector) {
      this.closingSelector = closingSelector;
    }
    WindowOperator.prototype.call = function(subscriber) {
      return new WindowSubscriber(subscriber, this.closingSelector);
    };
    return WindowOperator;
  })();
  var WindowSubscriber = (function(_super) {
    __extends(WindowSubscriber, _super);
    function WindowSubscriber(destination, closingSelector) {
      _super.call(this, destination);
      this.destination = destination;
      this.closingSelector = closingSelector;
      this.openWindow();
    }
    WindowSubscriber.prototype._next = function(value) {
      this.window.next(value);
    };
    WindowSubscriber.prototype._error = function(err) {
      this.window.error(err);
      this.destination.error(err);
      this._unsubscribeClosingNotification();
    };
    WindowSubscriber.prototype._complete = function() {
      this.window.complete();
      this.destination.complete();
      this._unsubscribeClosingNotification();
    };
    WindowSubscriber.prototype.unsubscribe = function() {
      _super.prototype.unsubscribe.call(this);
      this._unsubscribeClosingNotification();
    };
    WindowSubscriber.prototype._unsubscribeClosingNotification = function() {
      var closingNotification = this.closingNotification;
      if (closingNotification) {
        closingNotification.unsubscribe();
      }
    };
    WindowSubscriber.prototype.openWindow = function() {
      var prevClosingNotification = this.closingNotification;
      if (prevClosingNotification) {
        this.remove(prevClosingNotification);
        prevClosingNotification.unsubscribe();
      }
      var prevWindow = this.window;
      if (prevWindow) {
        prevWindow.complete();
      }
      var window = this.window = new Subject_1.Subject();
      this.destination.next(window);
      var closingNotifier = tryCatch_1.tryCatch(this.closingSelector)();
      if (closingNotifier === errorObject_1.errorObject) {
        var err = closingNotifier.e;
        this.destination.error(err);
        this.window.error(err);
      } else {
        var closingNotification = this.closingNotification = new Subscription_1.Subscription();
        closingNotification.add(closingNotifier._subscribe(new WindowClosingNotifierSubscriber(this)));
        this.add(closingNotification);
        this.add(window);
      }
    };
    return WindowSubscriber;
  })(Subscriber_1.Subscriber);
  var WindowClosingNotifierSubscriber = (function(_super) {
    __extends(WindowClosingNotifierSubscriber, _super);
    function WindowClosingNotifierSubscriber(parent) {
      _super.call(this, null);
      this.parent = parent;
    }
    WindowClosingNotifierSubscriber.prototype._next = function() {
      this.parent.openWindow();
    };
    WindowClosingNotifierSubscriber.prototype._error = function(err) {
      this.parent.error(err);
    };
    WindowClosingNotifierSubscriber.prototype._complete = function() {
      this.parent.openWindow();
    };
    return WindowClosingNotifierSubscriber;
  })(Subscriber_1.Subscriber);
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("e1", ["8", "e0"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var windowWhen_1 = $__require('e0');
  Observable_1.Observable.prototype.windowWhen = windowWhen_1.windowWhen;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("e2", ["e", "f", "49", "4a"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var __extends = (this && this.__extends) || function(d, b) {
    for (var p in b)
      if (b.hasOwnProperty(p))
        d[p] = b[p];
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
  var tryCatch_1 = $__require('e');
  var errorObject_1 = $__require('f');
  var OuterSubscriber_1 = $__require('49');
  var subscribeToResult_1 = $__require('4a');
  function withLatestFrom() {
    var args = [];
    for (var _i = 0; _i < arguments.length; _i++) {
      args[_i - 0] = arguments[_i];
    }
    var project;
    if (typeof args[args.length - 1] === 'function') {
      project = args.pop();
    }
    var observables = args;
    return this.lift(new WithLatestFromOperator(observables, project));
  }
  exports.withLatestFrom = withLatestFrom;
  var WithLatestFromOperator = (function() {
    function WithLatestFromOperator(observables, project) {
      this.observables = observables;
      this.project = project;
    }
    WithLatestFromOperator.prototype.call = function(subscriber) {
      return new WithLatestFromSubscriber(subscriber, this.observables, this.project);
    };
    return WithLatestFromOperator;
  })();
  var WithLatestFromSubscriber = (function(_super) {
    __extends(WithLatestFromSubscriber, _super);
    function WithLatestFromSubscriber(destination, observables, project) {
      _super.call(this, destination);
      this.observables = observables;
      this.project = project;
      this.toRespond = [];
      var len = observables.length;
      this.values = new Array(len);
      for (var i = 0; i < len; i++) {
        this.toRespond.push(i);
      }
      for (var i = 0; i < len; i++) {
        var observable = observables[i];
        this.add(subscribeToResult_1.subscribeToResult(this, observable, observable, i));
      }
    }
    WithLatestFromSubscriber.prototype.notifyNext = function(observable, value, observableIndex, index) {
      this.values[observableIndex] = value;
      var toRespond = this.toRespond;
      if (toRespond.length > 0) {
        var found = toRespond.indexOf(observableIndex);
        if (found !== -1) {
          toRespond.splice(found, 1);
        }
      }
    };
    WithLatestFromSubscriber.prototype.notifyComplete = function() {};
    WithLatestFromSubscriber.prototype._next = function(value) {
      if (this.toRespond.length === 0) {
        var values = this.values;
        var destination = this.destination;
        var project = this.project;
        var args = [value].concat(values);
        if (project) {
          var result = tryCatch_1.tryCatch(this.project).apply(this, args);
          if (result === errorObject_1.errorObject) {
            destination.error(result.e);
          } else {
            destination.next(result);
          }
        } else {
          destination.next(args);
        }
      }
    };
    return WithLatestFromSubscriber;
  })(OuterSubscriber_1.OuterSubscriber);
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("e3", ["8", "e2"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var withLatestFrom_1 = $__require('e2');
  Observable_1.Observable.prototype.withLatestFrom = withLatestFrom_1.withLatestFrom;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("33", ["8"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var __extends = (this && this.__extends) || function(d, b) {
    for (var p in b)
      if (b.hasOwnProperty(p))
        d[p] = b[p];
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
  var Observable_1 = $__require('8');
  var ErrorObservable = (function(_super) {
    __extends(ErrorObservable, _super);
    function ErrorObservable(error, scheduler) {
      _super.call(this);
      this.error = error;
      this.scheduler = scheduler;
    }
    ErrorObservable.create = function(error, scheduler) {
      return new ErrorObservable(error, scheduler);
    };
    ErrorObservable.dispatch = function(_a) {
      var error = _a.error,
          subscriber = _a.subscriber;
      subscriber.error(error);
    };
    ErrorObservable.prototype._subscribe = function(subscriber) {
      var error = this.error;
      var scheduler = this.scheduler;
      if (scheduler) {
        subscriber.add(scheduler.schedule(ErrorObservable.dispatch, 0, {
          error: error,
          subscriber: subscriber
        }));
      } else {
        subscriber.error(error);
      }
    };
    return ErrorObservable;
  })(Observable_1.Observable);
  exports.ErrorObservable = ErrorObservable;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("7d", ["8", "e", "f", "33", "15"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var __extends = (this && this.__extends) || function(d, b) {
    for (var p in b)
      if (b.hasOwnProperty(p))
        d[p] = b[p];
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
  var Observable_1 = $__require('8');
  var tryCatch_1 = $__require('e');
  var errorObject_1 = $__require('f');
  var throw_1 = $__require('33');
  var empty_1 = $__require('15');
  var ScalarObservable = (function(_super) {
    __extends(ScalarObservable, _super);
    function ScalarObservable(value, scheduler) {
      _super.call(this);
      this.value = value;
      this.scheduler = scheduler;
      this._isScalar = true;
    }
    ScalarObservable.create = function(value, scheduler) {
      return new ScalarObservable(value, scheduler);
    };
    ScalarObservable.dispatch = function(state) {
      var done = state.done,
          value = state.value,
          subscriber = state.subscriber;
      if (done) {
        subscriber.complete();
        return;
      }
      subscriber.next(value);
      if (subscriber.isUnsubscribed) {
        return;
      }
      state.done = true;
      this.schedule(state);
    };
    ScalarObservable.prototype._subscribe = function(subscriber) {
      var value = this.value;
      var scheduler = this.scheduler;
      if (scheduler) {
        subscriber.add(scheduler.schedule(ScalarObservable.dispatch, 0, {
          done: false,
          value: value,
          subscriber: subscriber
        }));
      } else {
        subscriber.next(value);
        if (!subscriber.isUnsubscribed) {
          subscriber.complete();
        }
      }
    };
    return ScalarObservable;
  })(Observable_1.Observable);
  exports.ScalarObservable = ScalarObservable;
  var proto = ScalarObservable.prototype;
  proto.map = function(project, thisArg) {
    var result = tryCatch_1.tryCatch(project).call(thisArg || this, this.value, 0);
    if (result === errorObject_1.errorObject) {
      return new throw_1.ErrorObservable(errorObject_1.errorObject.e);
    } else {
      return new ScalarObservable(project.call(thisArg || this, this.value, 0));
    }
  };
  proto.filter = function(select, thisArg) {
    var result = tryCatch_1.tryCatch(select).call(thisArg || this, this.value, 0);
    if (result === errorObject_1.errorObject) {
      return new throw_1.ErrorObservable(errorObject_1.errorObject.e);
    } else if (result) {
      return this;
    } else {
      return new empty_1.EmptyObservable();
    }
  };
  proto.reduce = function(project, seed) {
    if (typeof seed === 'undefined') {
      return this;
    }
    var result = tryCatch_1.tryCatch(project)(seed, this.value);
    if (result === errorObject_1.errorObject) {
      return new throw_1.ErrorObservable(errorObject_1.errorObject.e);
    } else {
      return new ScalarObservable(result);
    }
  };
  proto.scan = function(project, acc) {
    return this.reduce(project, acc);
  };
  proto.count = function(predicate) {
    if (!predicate) {
      return new ScalarObservable(1);
    } else {
      var result = tryCatch_1.tryCatch(predicate).call(this, this.value, 0, this);
      if (result === errorObject_1.errorObject) {
        return new throw_1.ErrorObservable(errorObject_1.errorObject.e);
      } else {
        return new ScalarObservable(result ? 1 : 0);
      }
    }
  };
  proto.skip = function(count) {
    if (count > 0) {
      return new empty_1.EmptyObservable();
    }
    return this;
  };
  proto.take = function(count) {
    if (count > 0) {
      return this;
    }
    return new empty_1.EmptyObservable();
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("15", ["8"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var __extends = (this && this.__extends) || function(d, b) {
    for (var p in b)
      if (b.hasOwnProperty(p))
        d[p] = b[p];
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
  var Observable_1 = $__require('8');
  var EmptyObservable = (function(_super) {
    __extends(EmptyObservable, _super);
    function EmptyObservable(scheduler) {
      _super.call(this);
      this.scheduler = scheduler;
    }
    EmptyObservable.create = function(scheduler) {
      return new EmptyObservable(scheduler);
    };
    EmptyObservable.dispatch = function(_a) {
      var subscriber = _a.subscriber;
      subscriber.complete();
    };
    EmptyObservable.prototype._subscribe = function(subscriber) {
      var scheduler = this.scheduler;
      if (scheduler) {
        subscriber.add(scheduler.schedule(EmptyObservable.dispatch, 0, {subscriber: subscriber}));
      } else {
        subscriber.complete();
      }
    };
    return EmptyObservable;
  })(Observable_1.Observable);
  exports.EmptyObservable = EmptyObservable;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("5", [], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  function isScheduler(value) {
    return value && typeof value.schedule === 'function';
  }
  exports.isScheduler = isScheduler;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("3", ["8", "7d", "15", "5"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var __extends = (this && this.__extends) || function(d, b) {
    for (var p in b)
      if (b.hasOwnProperty(p))
        d[p] = b[p];
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
  var Observable_1 = $__require('8');
  var ScalarObservable_1 = $__require('7d');
  var empty_1 = $__require('15');
  var isScheduler_1 = $__require('5');
  var ArrayObservable = (function(_super) {
    __extends(ArrayObservable, _super);
    function ArrayObservable(array, scheduler) {
      _super.call(this);
      this.array = array;
      this.scheduler = scheduler;
      if (!scheduler && array.length === 1) {
        this._isScalar = true;
        this.value = array[0];
      }
    }
    ArrayObservable.create = function(array, scheduler) {
      return new ArrayObservable(array, scheduler);
    };
    ArrayObservable.of = function() {
      var array = [];
      for (var _i = 0; _i < arguments.length; _i++) {
        array[_i - 0] = arguments[_i];
      }
      var scheduler = array[array.length - 1];
      if (isScheduler_1.isScheduler(scheduler)) {
        array.pop();
      } else {
        scheduler = void 0;
      }
      var len = array.length;
      if (len > 1) {
        return new ArrayObservable(array, scheduler);
      } else if (len === 1) {
        return new ScalarObservable_1.ScalarObservable(array[0], scheduler);
      } else {
        return new empty_1.EmptyObservable(scheduler);
      }
    };
    ArrayObservable.dispatch = function(state) {
      var array = state.array,
          index = state.index,
          count = state.count,
          subscriber = state.subscriber;
      if (index >= count) {
        subscriber.complete();
        return;
      }
      subscriber.next(array[index]);
      if (subscriber.isUnsubscribed) {
        return;
      }
      state.index = index + 1;
      this.schedule(state);
    };
    ArrayObservable.prototype._subscribe = function(subscriber) {
      var index = 0;
      var array = this.array;
      var count = array.length;
      var scheduler = this.scheduler;
      if (scheduler) {
        subscriber.add(scheduler.schedule(ArrayObservable.dispatch, 0, {
          array: array,
          index: index,
          count: count,
          subscriber: subscriber
        }));
      } else {
        for (var i = 0; i < count && !subscriber.isUnsubscribed; i++) {
          subscriber.next(array[i]);
        }
        subscriber.complete();
      }
    };
    return ArrayObservable;
  })(Observable_1.Observable);
  exports.ArrayObservable = ArrayObservable;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("38", ["3", "e4"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var fromArray_1 = $__require('3');
  var zip_support_1 = $__require('e4');
  function zip() {
    var observables = [];
    for (var _i = 0; _i < arguments.length; _i++) {
      observables[_i - 0] = arguments[_i];
    }
    var project = observables[observables.length - 1];
    if (typeof project === 'function') {
      observables.pop();
    }
    return new fromArray_1.ArrayObservable(observables).lift(new zip_support_1.ZipOperator(project));
  }
  exports.zip = zip;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("e5", ["38"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var zip_static_1 = $__require('38');
  function zipProto() {
    var observables = [];
    for (var _i = 0; _i < arguments.length; _i++) {
      observables[_i - 0] = arguments[_i];
    }
    observables.unshift(this);
    return zip_static_1.zip.apply(this, observables);
  }
  exports.zipProto = zipProto;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("e6", ["8", "e5"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var zip_1 = $__require('e5');
  Observable_1.Observable.prototype.zip = zip_1.zipProto;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("e", ["f"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var errorObject_1 = $__require('f');
  var tryCatchTarget;
  function tryCatcher() {
    try {
      return tryCatchTarget.apply(this, arguments);
    } catch (e) {
      errorObject_1.errorObject.e = e;
      return errorObject_1.errorObject;
    }
  }
  function tryCatch(fn) {
    tryCatchTarget = fn;
    return tryCatcher;
  }
  exports.tryCatch = tryCatch;
  ;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("f", [], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  exports.errorObject = {e: {}};
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("49", ["17"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var __extends = (this && this.__extends) || function(d, b) {
    for (var p in b)
      if (b.hasOwnProperty(p))
        d[p] = b[p];
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
  var Subscriber_1 = $__require('17');
  var OuterSubscriber = (function(_super) {
    __extends(OuterSubscriber, _super);
    function OuterSubscriber() {
      _super.apply(this, arguments);
    }
    OuterSubscriber.prototype.notifyComplete = function(inner) {
      this.destination.complete();
    };
    OuterSubscriber.prototype.notifyNext = function(outerValue, innerValue, outerIndex, innerIndex) {
      this.destination.next(innerValue);
    };
    OuterSubscriber.prototype.notifyError = function(error, inner) {
      this.destination.error(error);
    };
    return OuterSubscriber;
  })(Subscriber_1.Subscriber);
  exports.OuterSubscriber = OuterSubscriber;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("e7", ["17"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var __extends = (this && this.__extends) || function(d, b) {
    for (var p in b)
      if (b.hasOwnProperty(p))
        d[p] = b[p];
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
  var Subscriber_1 = $__require('17');
  var InnerSubscriber = (function(_super) {
    __extends(InnerSubscriber, _super);
    function InnerSubscriber(parent, outerValue, outerIndex) {
      _super.call(this);
      this.parent = parent;
      this.outerValue = outerValue;
      this.outerIndex = outerIndex;
      this.index = 0;
    }
    InnerSubscriber.prototype._next = function(value) {
      var index = this.index++;
      this.parent.notifyNext(this.outerValue, value, this.outerIndex, index);
    };
    InnerSubscriber.prototype._error = function(error) {
      this.parent.notifyError(error, this);
    };
    InnerSubscriber.prototype._complete = function() {
      this.parent.notifyComplete(this);
    };
    return InnerSubscriber;
  })(Subscriber_1.Subscriber);
  exports.InnerSubscriber = InnerSubscriber;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("4a", ["8", "1d", "e7"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var SymbolShim_1 = $__require('1d');
  var InnerSubscriber_1 = $__require('e7');
  var isArray = Array.isArray;
  function subscribeToResult(outerSubscriber, result, outerValue, outerIndex) {
    var destination = new InnerSubscriber_1.InnerSubscriber(outerSubscriber, outerValue, outerIndex);
    if (destination.isUnsubscribed) {
      return;
    }
    if (result instanceof Observable_1.Observable) {
      if (result._isScalar) {
        destination.next(result.value);
        destination.complete();
        return;
      } else {
        return result.subscribe(destination);
      }
    }
    if (isArray(result)) {
      for (var i = 0,
          len = result.length; i < len && !destination.isUnsubscribed; i++) {
        destination.next(result[i]);
      }
      if (!destination.isUnsubscribed) {
        destination.complete();
      }
    } else if (typeof result.then === 'function') {
      result.then(function(x) {
        if (!destination.isUnsubscribed) {
          destination.next(x);
          destination.complete();
        }
      }, function(err) {
        return destination.error(err);
      }).then(null, function(err) {
        setTimeout(function() {
          throw err;
        });
      });
      return destination;
    } else if (typeof result[SymbolShim_1.SymbolShim.iterator] === 'function') {
      for (var _i = 0,
          result_1 = result; _i < result_1.length; _i++) {
        var item = result_1[_i];
        destination.next(item);
        if (destination.isUnsubscribed) {
          break;
        }
      }
      if (!destination.isUnsubscribed) {
        destination.complete();
      }
    } else if (typeof result[SymbolShim_1.SymbolShim.observable] === 'function') {
      var obs = result[SymbolShim_1.SymbolShim.observable]();
      if (typeof obs.subscribe !== 'function') {
        destination.error('invalid observable');
      } else {
        return obs.subscribe(new InnerSubscriber_1.InnerSubscriber(outerSubscriber, outerValue, outerIndex));
      }
    } else {
      destination.error(new TypeError('unknown type returned'));
    }
  }
  exports.subscribeToResult = subscribeToResult;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("e4", ["17", "e", "f", "49", "4a", "1d"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var __extends = (this && this.__extends) || function(d, b) {
    for (var p in b)
      if (b.hasOwnProperty(p))
        d[p] = b[p];
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
  var Subscriber_1 = $__require('17');
  var tryCatch_1 = $__require('e');
  var errorObject_1 = $__require('f');
  var OuterSubscriber_1 = $__require('49');
  var subscribeToResult_1 = $__require('4a');
  var SymbolShim_1 = $__require('1d');
  var isArray = Array.isArray;
  var ZipOperator = (function() {
    function ZipOperator(project) {
      this.project = project;
    }
    ZipOperator.prototype.call = function(subscriber) {
      return new ZipSubscriber(subscriber, this.project);
    };
    return ZipOperator;
  })();
  exports.ZipOperator = ZipOperator;
  var ZipSubscriber = (function(_super) {
    __extends(ZipSubscriber, _super);
    function ZipSubscriber(destination, project, values) {
      if (values === void 0) {
        values = Object.create(null);
      }
      _super.call(this, destination);
      this.index = 0;
      this.iterators = [];
      this.active = 0;
      this.project = (typeof project === 'function') ? project : null;
      this.values = values;
    }
    ZipSubscriber.prototype._next = function(value) {
      var iterators = this.iterators;
      var index = this.index++;
      if (isArray(value)) {
        iterators.push(new StaticArrayIterator(value));
      } else if (typeof value[SymbolShim_1.SymbolShim.iterator] === 'function') {
        iterators.push(new StaticIterator(value[SymbolShim_1.SymbolShim.iterator]()));
      } else {
        iterators.push(new ZipBufferIterator(this.destination, this, value, index));
      }
    };
    ZipSubscriber.prototype._complete = function() {
      var iterators = this.iterators;
      var len = iterators.length;
      this.active = len;
      for (var i = 0; i < len; i++) {
        var iterator = iterators[i];
        if (iterator.stillUnsubscribed) {
          iterator.subscribe(iterator, i);
        } else {
          this.active--;
        }
      }
    };
    ZipSubscriber.prototype.notifyInactive = function() {
      this.active--;
      if (this.active === 0) {
        this.destination.complete();
      }
    };
    ZipSubscriber.prototype.checkIterators = function() {
      var iterators = this.iterators;
      var len = iterators.length;
      var destination = this.destination;
      for (var i = 0; i < len; i++) {
        var iterator = iterators[i];
        if (typeof iterator.hasValue === 'function' && !iterator.hasValue()) {
          return;
        }
      }
      var shouldComplete = false;
      var args = [];
      for (var i = 0; i < len; i++) {
        var iterator = iterators[i];
        var result = iterator.next();
        if (iterator.hasCompleted()) {
          shouldComplete = true;
        }
        if (result.done) {
          destination.complete();
          return;
        }
        args.push(result.value);
      }
      var project = this.project;
      if (project) {
        var result = tryCatch_1.tryCatch(project).apply(this, args);
        if (result === errorObject_1.errorObject) {
          destination.error(errorObject_1.errorObject.e);
        } else {
          destination.next(result);
        }
      } else {
        destination.next(args);
      }
      if (shouldComplete) {
        destination.complete();
      }
    };
    return ZipSubscriber;
  })(Subscriber_1.Subscriber);
  exports.ZipSubscriber = ZipSubscriber;
  var StaticIterator = (function() {
    function StaticIterator(iterator) {
      this.iterator = iterator;
      this.nextResult = iterator.next();
    }
    StaticIterator.prototype.hasValue = function() {
      return true;
    };
    StaticIterator.prototype.next = function() {
      var result = this.nextResult;
      this.nextResult = this.iterator.next();
      return result;
    };
    StaticIterator.prototype.hasCompleted = function() {
      var nextResult = this.nextResult;
      return nextResult && nextResult.done;
    };
    return StaticIterator;
  })();
  var StaticArrayIterator = (function() {
    function StaticArrayIterator(array) {
      this.array = array;
      this.index = 0;
      this.length = 0;
      this.length = array.length;
    }
    StaticArrayIterator.prototype[SymbolShim_1.SymbolShim.iterator] = function() {
      return this;
    };
    StaticArrayIterator.prototype.next = function(value) {
      var i = this.index++;
      var array = this.array;
      return i < this.length ? {
        value: array[i],
        done: false
      } : {done: true};
    };
    StaticArrayIterator.prototype.hasValue = function() {
      return this.array.length > this.index;
    };
    StaticArrayIterator.prototype.hasCompleted = function() {
      return this.array.length === this.index;
    };
    return StaticArrayIterator;
  })();
  var ZipBufferIterator = (function(_super) {
    __extends(ZipBufferIterator, _super);
    function ZipBufferIterator(destination, parent, observable, index) {
      _super.call(this, destination);
      this.parent = parent;
      this.observable = observable;
      this.index = index;
      this.stillUnsubscribed = true;
      this.buffer = [];
      this.isComplete = false;
    }
    ZipBufferIterator.prototype[SymbolShim_1.SymbolShim.iterator] = function() {
      return this;
    };
    ZipBufferIterator.prototype.next = function() {
      var buffer = this.buffer;
      if (buffer.length === 0 && this.isComplete) {
        return {done: true};
      } else {
        return {
          value: buffer.shift(),
          done: false
        };
      }
    };
    ZipBufferIterator.prototype.hasValue = function() {
      return this.buffer.length > 0;
    };
    ZipBufferIterator.prototype.hasCompleted = function() {
      return this.buffer.length === 0 && this.isComplete;
    };
    ZipBufferIterator.prototype.notifyComplete = function() {
      if (this.buffer.length > 0) {
        this.isComplete = true;
        this.parent.notifyInactive();
      } else {
        this.destination.complete();
      }
    };
    ZipBufferIterator.prototype.notifyNext = function(outerValue, innerValue, outerIndex, innerIndex) {
      this.buffer.push(innerValue);
      this.parent.checkIterators();
    };
    ZipBufferIterator.prototype.subscribe = function(value, index) {
      this.add(subscribeToResult_1.subscribeToResult(this, this.observable, this, index));
    };
    return ZipBufferIterator;
  })(OuterSubscriber_1.OuterSubscriber);
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("e8", ["e4"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var zip_support_1 = $__require('e4');
  function zipAll(project) {
    return this.lift(new zip_support_1.ZipOperator(project));
  }
  exports.zipAll = zipAll;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("e9", ["8", "e8"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var zipAll_1 = $__require('e8');
  Observable_1.Observable.prototype.zipAll = zipAll_1.zipAll;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("10", ["78"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var __extends = (this && this.__extends) || function(d, b) {
    for (var p in b)
      if (b.hasOwnProperty(p))
        d[p] = b[p];
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
  var Subject_1 = $__require('78');
  var AsyncSubject = (function(_super) {
    __extends(AsyncSubject, _super);
    function AsyncSubject() {
      _super.call(this);
      this._value = void 0;
      this._hasNext = false;
      this._isScalar = false;
    }
    AsyncSubject.prototype._subscribe = function(subscriber) {
      if (this.completeSignal && this._hasNext) {
        subscriber.next(this._value);
      }
      return _super.prototype._subscribe.call(this, subscriber);
    };
    AsyncSubject.prototype._next = function(value) {
      this._value = value;
      this._hasNext = true;
    };
    AsyncSubject.prototype._complete = function() {
      var index = -1;
      var observers = this.observers;
      var len = observers.length;
      this.observers = void 0;
      this.isUnsubscribed = true;
      if (this._hasNext) {
        while (++index < len) {
          var o = observers[index];
          o.next(this._value);
          o.complete();
        }
      } else {
        while (++index < len) {
          observers[index].complete();
        }
      }
      this.isUnsubscribed = false;
    };
    return AsyncSubject;
  })(Subject_1.Subject);
  exports.AsyncSubject = AsyncSubject;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("9c", ["78", "20"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var __extends = (this && this.__extends) || function(d, b) {
    for (var p in b)
      if (b.hasOwnProperty(p))
        d[p] = b[p];
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
  var Subject_1 = $__require('78');
  var queue_1 = $__require('20');
  var ReplaySubject = (function(_super) {
    __extends(ReplaySubject, _super);
    function ReplaySubject(bufferSize, windowTime, scheduler) {
      if (bufferSize === void 0) {
        bufferSize = Number.POSITIVE_INFINITY;
      }
      if (windowTime === void 0) {
        windowTime = Number.POSITIVE_INFINITY;
      }
      _super.call(this);
      this.events = [];
      this.bufferSize = bufferSize < 1 ? 1 : bufferSize;
      this._windowTime = windowTime < 1 ? 1 : windowTime;
      this.scheduler = scheduler;
    }
    ReplaySubject.prototype._next = function(value) {
      var now = this._getNow();
      this.events.push(new ReplayEvent(now, value));
      this._trimBufferThenGetEvents(now);
      _super.prototype._next.call(this, value);
    };
    ReplaySubject.prototype._subscribe = function(subscriber) {
      var events = this._trimBufferThenGetEvents(this._getNow());
      var index = -1;
      var len = events.length;
      while (!subscriber.isUnsubscribed && ++index < len) {
        subscriber.next(events[index].value);
      }
      return _super.prototype._subscribe.call(this, subscriber);
    };
    ReplaySubject.prototype._getNow = function() {
      return (this.scheduler || queue_1.queue).now();
    };
    ReplaySubject.prototype._trimBufferThenGetEvents = function(now) {
      var bufferSize = this.bufferSize;
      var _windowTime = this._windowTime;
      var events = this.events;
      var eventsCount = events.length;
      var spliceCount = 0;
      while (spliceCount < eventsCount) {
        if ((now - events[spliceCount].time) < _windowTime) {
          break;
        }
        spliceCount += 1;
      }
      if (eventsCount > bufferSize) {
        spliceCount = Math.max(spliceCount, eventsCount - bufferSize);
      }
      if (spliceCount > 0) {
        events.splice(0, spliceCount);
      }
      return events;
    };
    return ReplaySubject;
  })(Subject_1.Subject);
  exports.ReplaySubject = ReplaySubject;
  var ReplayEvent = (function() {
    function ReplayEvent(time, value) {
      this.time = time;
      this.value = value;
    }
    return ReplayEvent;
  })();
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("ea", ["24", "17"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var __extends = (this && this.__extends) || function(d, b) {
    for (var p in b)
      if (b.hasOwnProperty(p))
        d[p] = b[p];
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
  var Subscription_1 = $__require('24');
  var Subscriber_1 = $__require('17');
  var SubjectSubscription = (function(_super) {
    __extends(SubjectSubscription, _super);
    function SubjectSubscription(subject, observer) {
      _super.call(this);
      this.subject = subject;
      this.observer = observer;
      this.isUnsubscribed = false;
    }
    SubjectSubscription.prototype.unsubscribe = function() {
      if (this.isUnsubscribed) {
        return;
      }
      this.isUnsubscribed = true;
      var subject = this.subject;
      var observers = subject.observers;
      this.subject = void 0;
      if (!observers || observers.length === 0 || subject.isUnsubscribed) {
        return;
      }
      if (this.observer instanceof Subscriber_1.Subscriber) {
        this.observer.unsubscribe();
      }
      var subscriberIndex = observers.indexOf(this.observer);
      if (subscriberIndex !== -1) {
        observers.splice(subscriberIndex, 1);
      }
    };
    return SubjectSubscription;
  })(Subscription_1.Subscription);
  exports.SubjectSubscription = SubjectSubscription;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("78", ["8", "17", "24", "ea", "eb"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var __extends = (this && this.__extends) || function(d, b) {
    for (var p in b)
      if (b.hasOwnProperty(p))
        d[p] = b[p];
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
  var Observable_1 = $__require('8');
  var Subscriber_1 = $__require('17');
  var Subscription_1 = $__require('24');
  var SubjectSubscription_1 = $__require('ea');
  var rxSubscriber_1 = $__require('eb');
  var subscriptionAdd = Subscription_1.Subscription.prototype.add;
  var subscriptionRemove = Subscription_1.Subscription.prototype.remove;
  var subscriptionUnsubscribe = Subscription_1.Subscription.prototype.unsubscribe;
  var subscriberNext = Subscriber_1.Subscriber.prototype.next;
  var subscriberError = Subscriber_1.Subscriber.prototype.error;
  var subscriberComplete = Subscriber_1.Subscriber.prototype.complete;
  var _subscriberNext = Subscriber_1.Subscriber.prototype._next;
  var _subscriberError = Subscriber_1.Subscriber.prototype._error;
  var _subscriberComplete = Subscriber_1.Subscriber.prototype._complete;
  var Subject = (function(_super) {
    __extends(Subject, _super);
    function Subject() {
      _super.apply(this, arguments);
      this.observers = [];
      this.isUnsubscribed = false;
      this.dispatching = false;
      this.errorSignal = false;
      this.completeSignal = false;
    }
    Subject.prototype[rxSubscriber_1.rxSubscriber] = function() {
      return this;
    };
    Subject.create = function(source, destination) {
      return new BidirectionalSubject(source, destination);
    };
    Subject.prototype.lift = function(operator) {
      var subject = new BidirectionalSubject(this, this.destination || this);
      subject.operator = operator;
      return subject;
    };
    Subject.prototype._subscribe = function(subscriber) {
      if (subscriber.isUnsubscribed) {
        return;
      } else if (this.errorSignal) {
        subscriber.error(this.errorInstance);
        return;
      } else if (this.completeSignal) {
        subscriber.complete();
        return;
      } else if (this.isUnsubscribed) {
        throw new Error('Cannot subscribe to a disposed Subject.');
      }
      this.observers.push(subscriber);
      return new SubjectSubscription_1.SubjectSubscription(this, subscriber);
    };
    Subject.prototype.add = function(subscription) {
      subscriptionAdd.call(this, subscription);
    };
    Subject.prototype.remove = function(subscription) {
      subscriptionRemove.call(this, subscription);
    };
    Subject.prototype.unsubscribe = function() {
      this.observers = void 0;
      subscriptionUnsubscribe.call(this);
    };
    Subject.prototype.next = function(value) {
      if (this.isUnsubscribed) {
        return;
      }
      this.dispatching = true;
      this._next(value);
      this.dispatching = false;
      if (this.errorSignal) {
        this.error(this.errorInstance);
      } else if (this.completeSignal) {
        this.complete();
      }
    };
    Subject.prototype.error = function(err) {
      if (this.isUnsubscribed || this.completeSignal) {
        return;
      }
      this.errorSignal = true;
      this.errorInstance = err;
      if (this.dispatching) {
        return;
      }
      this._error(err);
      this.unsubscribe();
    };
    Subject.prototype.complete = function() {
      if (this.isUnsubscribed || this.errorSignal) {
        return;
      }
      this.completeSignal = true;
      if (this.dispatching) {
        return;
      }
      this._complete();
      this.unsubscribe();
    };
    Subject.prototype._next = function(value) {
      var index = -1;
      var observers = this.observers.slice(0);
      var len = observers.length;
      while (++index < len) {
        observers[index].next(value);
      }
    };
    Subject.prototype._error = function(err) {
      var index = -1;
      var observers = this.observers;
      var len = observers.length;
      this.observers = void 0;
      this.isUnsubscribed = true;
      while (++index < len) {
        observers[index].error(err);
      }
      this.isUnsubscribed = false;
    };
    Subject.prototype._complete = function() {
      var index = -1;
      var observers = this.observers;
      var len = observers.length;
      this.observers = void 0;
      this.isUnsubscribed = true;
      while (++index < len) {
        observers[index].complete();
      }
      this.isUnsubscribed = false;
    };
    return Subject;
  })(Observable_1.Observable);
  exports.Subject = Subject;
  var BidirectionalSubject = (function(_super) {
    __extends(BidirectionalSubject, _super);
    function BidirectionalSubject(source, destination) {
      _super.call(this);
      this.source = source;
      this.destination = destination;
    }
    BidirectionalSubject.prototype._subscribe = function(subscriber) {
      var operator = this.operator;
      return this.source._subscribe.call(this.source, operator ? operator.call(subscriber) : subscriber);
    };
    BidirectionalSubject.prototype.next = function(value) {
      subscriberNext.call(this, value);
    };
    BidirectionalSubject.prototype.error = function(err) {
      subscriberError.call(this, err);
    };
    BidirectionalSubject.prototype.complete = function() {
      subscriberComplete.call(this);
    };
    BidirectionalSubject.prototype._next = function(value) {
      _subscriberNext.call(this, value);
    };
    BidirectionalSubject.prototype._error = function(err) {
      _subscriberError.call(this, err);
    };
    BidirectionalSubject.prototype._complete = function() {
      _subscriberComplete.call(this);
    };
    return BidirectionalSubject;
  })(Subject);
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("99", ["78", "ec", "ed"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var __extends = (this && this.__extends) || function(d, b) {
    for (var p in b)
      if (b.hasOwnProperty(p))
        d[p] = b[p];
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
  var Subject_1 = $__require('78');
  var throwError_1 = $__require('ec');
  var ObjectUnsubscribedError_1 = $__require('ed');
  var BehaviorSubject = (function(_super) {
    __extends(BehaviorSubject, _super);
    function BehaviorSubject(_value) {
      _super.call(this);
      this._value = _value;
      this._hasError = false;
    }
    BehaviorSubject.prototype.getValue = function() {
      if (this._hasError) {
        throwError_1.throwError(this._err);
      } else if (this.isUnsubscribed) {
        throwError_1.throwError(new ObjectUnsubscribedError_1.ObjectUnsubscribedError());
      } else {
        return this._value;
      }
    };
    Object.defineProperty(BehaviorSubject.prototype, "value", {
      get: function() {
        return this.getValue();
      },
      enumerable: true,
      configurable: true
    });
    BehaviorSubject.prototype._subscribe = function(subscriber) {
      var subscription = _super.prototype._subscribe.call(this, subscriber);
      if (!subscription) {
        return;
      } else if (!subscription.isUnsubscribed) {
        subscriber.next(this._value);
      }
      return subscription;
    };
    BehaviorSubject.prototype._next = function(value) {
      _super.prototype._next.call(this, this._value = value);
    };
    BehaviorSubject.prototype._error = function(err) {
      this._hasError = true;
      _super.prototype._error.call(this, this._err = err);
    };
    return BehaviorSubject;
  })(Subject_1.Subject);
  exports.BehaviorSubject = BehaviorSubject;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("af", ["8", "24", "17"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var __extends = (this && this.__extends) || function(d, b) {
    for (var p in b)
      if (b.hasOwnProperty(p))
        d[p] = b[p];
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
  var Observable_1 = $__require('8');
  var Subscription_1 = $__require('24');
  var Subscriber_1 = $__require('17');
  var ConnectableObservable = (function(_super) {
    __extends(ConnectableObservable, _super);
    function ConnectableObservable(source, subjectFactory) {
      _super.call(this);
      this.source = source;
      this.subjectFactory = subjectFactory;
    }
    ConnectableObservable.prototype._subscribe = function(subscriber) {
      return this._getSubject().subscribe(subscriber);
    };
    ConnectableObservable.prototype._getSubject = function() {
      var subject = this.subject;
      if (subject && !subject.isUnsubscribed) {
        return subject;
      }
      return (this.subject = this.subjectFactory());
    };
    ConnectableObservable.prototype.connect = function() {
      var source = this.source;
      var subscription = this.subscription;
      if (subscription && !subscription.isUnsubscribed) {
        return subscription;
      }
      subscription = source.subscribe(this._getSubject());
      subscription.add(new ConnectableSubscription(this));
      return (this.subscription = subscription);
    };
    ConnectableObservable.prototype.refCount = function() {
      return new RefCountObservable(this);
    };
    return ConnectableObservable;
  })(Observable_1.Observable);
  exports.ConnectableObservable = ConnectableObservable;
  var ConnectableSubscription = (function(_super) {
    __extends(ConnectableSubscription, _super);
    function ConnectableSubscription(connectable) {
      _super.call(this);
      this.connectable = connectable;
    }
    ConnectableSubscription.prototype._unsubscribe = function() {
      var connectable = this.connectable;
      connectable.subject = void 0;
      connectable.subscription = void 0;
      this.connectable = void 0;
    };
    return ConnectableSubscription;
  })(Subscription_1.Subscription);
  var RefCountObservable = (function(_super) {
    __extends(RefCountObservable, _super);
    function RefCountObservable(connectable, refCount) {
      if (refCount === void 0) {
        refCount = 0;
      }
      _super.call(this);
      this.connectable = connectable;
      this.refCount = refCount;
    }
    RefCountObservable.prototype._subscribe = function(subscriber) {
      var connectable = this.connectable;
      var refCountSubscriber = new RefCountSubscriber(subscriber, this);
      var subscription = connectable.subscribe(refCountSubscriber);
      if (!subscription.isUnsubscribed && ++this.refCount === 1) {
        refCountSubscriber.connection = this.connection = connectable.connect();
      }
      return subscription;
    };
    return RefCountObservable;
  })(Observable_1.Observable);
  var RefCountSubscriber = (function(_super) {
    __extends(RefCountSubscriber, _super);
    function RefCountSubscriber(destination, refCountObservable) {
      _super.call(this, null);
      this.destination = destination;
      this.refCountObservable = refCountObservable;
      this.connection = refCountObservable.connection;
      destination.add(this);
    }
    RefCountSubscriber.prototype._next = function(value) {
      this.destination.next(value);
    };
    RefCountSubscriber.prototype._error = function(err) {
      this._resetConnectable();
      this.destination.error(err);
    };
    RefCountSubscriber.prototype._complete = function() {
      this._resetConnectable();
      this.destination.complete();
    };
    RefCountSubscriber.prototype._resetConnectable = function() {
      var observable = this.refCountObservable;
      var obsConnection = observable.connection;
      var subConnection = this.connection;
      if (subConnection && subConnection === obsConnection) {
        observable.refCount = 0;
        obsConnection.unsubscribe();
        observable.connection = void 0;
        this.unsubscribe();
      }
    };
    RefCountSubscriber.prototype._unsubscribe = function() {
      var observable = this.refCountObservable;
      if (observable.refCount === 0) {
        return;
      }
      if (--observable.refCount === 0) {
        var obsConnection = observable.connection;
        var subConnection = this.connection;
        if (subConnection && subConnection === obsConnection) {
          obsConnection.unsubscribe();
          observable.connection = void 0;
        }
      }
    };
    return RefCountSubscriber;
  })(Subscriber_1.Subscriber);
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("ec", [], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  function throwError(e) {
    throw e;
  }
  exports.throwError = throwError;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("ee", [], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  function tryOrOnError(target) {
    function tryCatcher() {
      try {
        tryCatcher.target.apply(this, arguments);
      } catch (e) {
        this.error(e);
      }
    }
    tryCatcher.target = target;
    return tryCatcher;
  }
  exports.tryOrOnError = tryOrOnError;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("17", ["2e", "ec", "ee", "24", "eb"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var __extends = (this && this.__extends) || function(d, b) {
    for (var p in b)
      if (b.hasOwnProperty(p))
        d[p] = b[p];
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
  var noop_1 = $__require('2e');
  var throwError_1 = $__require('ec');
  var tryOrOnError_1 = $__require('ee');
  var Subscription_1 = $__require('24');
  var rxSubscriber_1 = $__require('eb');
  var Subscriber = (function(_super) {
    __extends(Subscriber, _super);
    function Subscriber(destination) {
      _super.call(this);
      this.destination = destination;
      this._isUnsubscribed = false;
      if (!this.destination) {
        return;
      }
      var subscription = destination._subscription;
      if (subscription) {
        this._subscription = subscription;
      } else if (destination instanceof Subscriber) {
        this._subscription = destination;
      }
    }
    Subscriber.prototype[rxSubscriber_1.rxSubscriber] = function() {
      return this;
    };
    Object.defineProperty(Subscriber.prototype, "isUnsubscribed", {
      get: function() {
        var subscription = this._subscription;
        if (subscription) {
          return this._isUnsubscribed || subscription.isUnsubscribed;
        } else {
          return this._isUnsubscribed;
        }
      },
      set: function(value) {
        var subscription = this._subscription;
        if (subscription) {
          subscription.isUnsubscribed = Boolean(value);
        } else {
          this._isUnsubscribed = Boolean(value);
        }
      },
      enumerable: true,
      configurable: true
    });
    Subscriber.create = function(next, error, complete) {
      var subscriber = new Subscriber();
      subscriber._next = (typeof next === 'function') && tryOrOnError_1.tryOrOnError(next) || noop_1.noop;
      subscriber._error = (typeof error === 'function') && error || throwError_1.throwError;
      subscriber._complete = (typeof complete === 'function') && complete || noop_1.noop;
      return subscriber;
    };
    Subscriber.prototype.add = function(sub) {
      var _subscription = this._subscription;
      if (_subscription) {
        _subscription.add(sub);
      } else {
        _super.prototype.add.call(this, sub);
      }
    };
    Subscriber.prototype.remove = function(sub) {
      if (this._subscription) {
        this._subscription.remove(sub);
      } else {
        _super.prototype.remove.call(this, sub);
      }
    };
    Subscriber.prototype.unsubscribe = function() {
      if (this._isUnsubscribed) {
        return;
      } else if (this._subscription) {
        this._isUnsubscribed = true;
      } else {
        _super.prototype.unsubscribe.call(this);
      }
    };
    Subscriber.prototype._next = function(value) {
      var destination = this.destination;
      if (destination.next) {
        destination.next(value);
      }
    };
    Subscriber.prototype._error = function(err) {
      var destination = this.destination;
      if (destination.error) {
        destination.error(err);
      }
    };
    Subscriber.prototype._complete = function() {
      var destination = this.destination;
      if (destination.complete) {
        destination.complete();
      }
    };
    Subscriber.prototype.next = function(value) {
      if (!this.isUnsubscribed) {
        this._next(value);
      }
    };
    Subscriber.prototype.error = function(err) {
      if (!this.isUnsubscribed) {
        this._error(err);
        this.unsubscribe();
      }
    };
    Subscriber.prototype.complete = function() {
      if (!this.isUnsubscribed) {
        this._complete();
        this.unsubscribe();
      }
    };
    return Subscriber;
  })(Subscription_1.Subscription);
  exports.Subscriber = Subscriber;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("8", ["17", "1c", "1d", "eb"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Subscriber_1 = $__require('17');
  var root_1 = $__require('1c');
  var SymbolShim_1 = $__require('1d');
  var rxSubscriber_1 = $__require('eb');
  var Observable = (function() {
    function Observable(subscribe) {
      this._isScalar = false;
      if (subscribe) {
        this._subscribe = subscribe;
      }
    }
    Observable.prototype.lift = function(operator) {
      var observable = new Observable();
      observable.source = this;
      observable.operator = operator;
      return observable;
    };
    Observable.prototype[SymbolShim_1.SymbolShim.observable] = function() {
      return this;
    };
    Observable.prototype.subscribe = function(observerOrNext, error, complete) {
      var subscriber;
      if (observerOrNext && typeof observerOrNext === 'object') {
        if (observerOrNext instanceof Subscriber_1.Subscriber) {
          subscriber = observerOrNext;
        } else if (observerOrNext[rxSubscriber_1.rxSubscriber]) {
          subscriber = observerOrNext[rxSubscriber_1.rxSubscriber]();
        } else {
          subscriber = new Subscriber_1.Subscriber(observerOrNext);
        }
      } else {
        var next = observerOrNext;
        subscriber = Subscriber_1.Subscriber.create(next, error, complete);
      }
      subscriber.add(this._subscribe(subscriber));
      return subscriber;
    };
    Observable.prototype.forEach = function(next, thisArg, PromiseCtor) {
      if (!PromiseCtor) {
        if (root_1.root.Rx && root_1.root.Rx.config && root_1.root.Rx.config.Promise) {
          PromiseCtor = root_1.root.Rx.config.Promise;
        } else if (root_1.root.Promise) {
          PromiseCtor = root_1.root.Promise;
        }
      }
      if (!PromiseCtor) {
        throw new Error('no Promise impl found');
      }
      var nextHandler;
      if (thisArg) {
        nextHandler = function nextHandlerFn(value) {
          var _a = nextHandlerFn,
              thisArg = _a.thisArg,
              next = _a.next;
          return next.call(thisArg, value);
        };
        nextHandler.thisArg = thisArg;
        nextHandler.next = next;
      } else {
        nextHandler = next;
      }
      var promiseCallback = function promiseCallbackFn(resolve, reject) {
        var _a = promiseCallbackFn,
            source = _a.source,
            nextHandler = _a.nextHandler;
        source.subscribe(nextHandler, reject, resolve);
      };
      promiseCallback.source = this;
      promiseCallback.nextHandler = nextHandler;
      return new PromiseCtor(promiseCallback);
    };
    Observable.prototype._subscribe = function(subscriber) {
      return this.source._subscribe(this.operator.call(subscriber));
    };
    Observable.create = function(subscribe) {
      return new Observable(subscribe);
    };
    return Observable;
  })();
  exports.Observable = Observable;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("63", ["8"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Observable_1 = $__require('8');
  var Notification = (function() {
    function Notification(kind, value, exception) {
      this.kind = kind;
      this.value = value;
      this.exception = exception;
      this.hasValue = kind === 'N';
    }
    Notification.prototype.observe = function(observer) {
      switch (this.kind) {
        case 'N':
          return observer.next(this.value);
        case 'E':
          return observer.error(this.exception);
        case 'C':
          return observer.complete();
      }
    };
    Notification.prototype.do = function(next, error, complete) {
      var kind = this.kind;
      switch (kind) {
        case 'N':
          return next(this.value);
        case 'E':
          return error(this.exception);
        case 'C':
          return complete();
      }
    };
    Notification.prototype.accept = function(nextOrObserver, error, complete) {
      if (nextOrObserver && typeof nextOrObserver.next === 'function') {
        return this.observe(nextOrObserver);
      } else {
        return this.do(nextOrObserver, error, complete);
      }
    };
    Notification.prototype.toObservable = function() {
      var kind = this.kind;
      switch (kind) {
        case 'N':
          return Observable_1.Observable.of(this.value);
        case 'E':
          return Observable_1.Observable.throw(this.exception);
        case 'C':
          return Observable_1.Observable.empty();
      }
    };
    Notification.createNext = function(value) {
      if (typeof value !== 'undefined') {
        return new Notification('N', value);
      }
      return this.undefinedValueNotification;
    };
    Notification.createError = function(err) {
      return new Notification('E', undefined, err);
    };
    Notification.createComplete = function() {
      return this.completeNotification;
    };
    Notification.completeNotification = new Notification('C');
    Notification.undefinedValueNotification = new Notification('N', undefined);
    return Notification;
  })();
  exports.Notification = Notification;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("71", [], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var EmptyError = (function() {
    function EmptyError() {
      this.name = 'EmptyError';
      this.message = 'no elements in sequence';
    }
    return EmptyError;
  })();
  exports.EmptyError = EmptyError;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("c6", [], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var ArgumentOutOfRangeError = (function() {
    function ArgumentOutOfRangeError() {
      this.name = 'ArgumentOutOfRangeError';
      this.message = 'argument out of range';
    }
    return ArgumentOutOfRangeError;
  })();
  exports.ArgumentOutOfRangeError = ArgumentOutOfRangeError;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("ed", [], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var __extends = (this && this.__extends) || function(d, b) {
    for (var p in b)
      if (b.hasOwnProperty(p))
        d[p] = b[p];
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
  var ObjectUnsubscribedError = (function(_super) {
    __extends(ObjectUnsubscribedError, _super);
    function ObjectUnsubscribedError() {
      _super.call(this, 'object unsubscribed');
      this.name = 'ObjectUnsubscribedError';
    }
    return ObjectUnsubscribedError;
  })(Error);
  exports.ObjectUnsubscribedError = ObjectUnsubscribedError;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("ef", [], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var process = module.exports = {};
  var queue = [];
  var draining = false;
  var currentQueue;
  var queueIndex = -1;
  function cleanUpNextTick() {
    draining = false;
    if (currentQueue.length) {
      queue = currentQueue.concat(queue);
    } else {
      queueIndex = -1;
    }
    if (queue.length) {
      drainQueue();
    }
  }
  function drainQueue() {
    if (draining) {
      return;
    }
    var timeout = setTimeout(cleanUpNextTick);
    draining = true;
    var len = queue.length;
    while (len) {
      currentQueue = queue;
      queue = [];
      while (++queueIndex < len) {
        if (currentQueue) {
          currentQueue[queueIndex].run();
        }
      }
      queueIndex = -1;
      len = queue.length;
    }
    currentQueue = null;
    draining = false;
    clearTimeout(timeout);
  }
  process.nextTick = function(fun) {
    var args = new Array(arguments.length - 1);
    if (arguments.length > 1) {
      for (var i = 1; i < arguments.length; i++) {
        args[i - 1] = arguments[i];
      }
    }
    queue.push(new Item(fun, args));
    if (queue.length === 1 && !draining) {
      setTimeout(drainQueue, 0);
    }
  };
  function Item(fun, array) {
    this.fun = fun;
    this.array = array;
  }
  Item.prototype.run = function() {
    this.fun.apply(null, this.array);
  };
  process.title = 'browser';
  process.browser = true;
  process.env = {};
  process.argv = [];
  process.version = '';
  process.versions = {};
  function noop() {}
  process.on = noop;
  process.addListener = noop;
  process.once = noop;
  process.off = noop;
  process.removeListener = noop;
  process.removeAllListeners = noop;
  process.emit = noop;
  process.binding = function(name) {
    throw new Error('process.binding is not supported');
  };
  process.cwd = function() {
    return '/';
  };
  process.chdir = function(dir) {
    throw new Error('process.chdir is not supported');
  };
  process.umask = function() {
    return 0;
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("f0", ["ef"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = $__require('ef');
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("f1", ["f0"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = $__System._nodeRequire ? process : $__require('f0');
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("43", ["f1"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = $__require('f1');
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("f2", ["1c", "43"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    var root_1 = $__require('1c');
    var ImmediateDefinition = (function() {
      function ImmediateDefinition(root) {
        this.root = root;
        if (root.setImmediate) {
          this.setImmediate = root.setImmediate;
          this.clearImmediate = root.clearImmediate;
        } else {
          this.nextHandle = 1;
          this.tasksByHandle = {};
          this.currentlyRunningATask = false;
          if (this.canUseProcessNextTick()) {
            this.setImmediate = this.createProcessNextTickSetImmediate();
          } else if (this.canUsePostMessage()) {
            this.setImmediate = this.createPostMessageSetImmediate();
          } else if (this.canUseMessageChannel()) {
            this.setImmediate = this.createMessageChannelSetImmediate();
          } else if (this.canUseReadyStateChange()) {
            this.setImmediate = this.createReadyStateChangeSetImmediate();
          } else {
            this.setImmediate = this.createSetTimeoutSetImmediate();
          }
          var ci = function clearImmediate(handle) {
            delete clearImmediate.instance.tasksByHandle[handle];
          };
          ci.instance = this;
          this.clearImmediate = ci;
        }
      }
      ImmediateDefinition.prototype.identify = function(o) {
        return this.root.Object.prototype.toString.call(o);
      };
      ImmediateDefinition.prototype.canUseProcessNextTick = function() {
        return this.identify(this.root.process) === '[object process]';
      };
      ImmediateDefinition.prototype.canUseMessageChannel = function() {
        return Boolean(this.root.MessageChannel);
      };
      ImmediateDefinition.prototype.canUseReadyStateChange = function() {
        var document = this.root.document;
        return Boolean(document && 'onreadystatechange' in document.createElement('script'));
      };
      ImmediateDefinition.prototype.canUsePostMessage = function() {
        var root = this.root;
        if (root.postMessage && !root.importScripts) {
          var postMessageIsAsynchronous = true;
          var oldOnMessage = root.onmessage;
          root.onmessage = function() {
            postMessageIsAsynchronous = false;
          };
          root.postMessage('', '*');
          root.onmessage = oldOnMessage;
          return postMessageIsAsynchronous;
        }
        return false;
      };
      ImmediateDefinition.prototype.partiallyApplied = function(handler) {
        var args = [];
        for (var _i = 1; _i < arguments.length; _i++) {
          args[_i - 1] = arguments[_i];
        }
        var fn = function result() {
          var _a = result,
              handler = _a.handler,
              args = _a.args;
          if (typeof handler === 'function') {
            handler.apply(undefined, args);
          } else {
            (new Function('' + handler))();
          }
        };
        fn.handler = handler;
        fn.args = args;
        return fn;
      };
      ImmediateDefinition.prototype.addFromSetImmediateArguments = function(args) {
        this.tasksByHandle[this.nextHandle] = this.partiallyApplied.apply(undefined, args);
        return this.nextHandle++;
      };
      ImmediateDefinition.prototype.createProcessNextTickSetImmediate = function() {
        var fn = function setImmediate() {
          var instance = setImmediate.instance;
          var handle = instance.addFromSetImmediateArguments(arguments);
          instance.root.process.nextTick(instance.partiallyApplied(instance.runIfPresent, handle));
          return handle;
        };
        fn.instance = this;
        return fn;
      };
      ImmediateDefinition.prototype.createPostMessageSetImmediate = function() {
        var root = this.root;
        var messagePrefix = 'setImmediate$' + root.Math.random() + '$';
        var onGlobalMessage = function globalMessageHandler(event) {
          var instance = globalMessageHandler.instance;
          if (event.source === root && typeof event.data === 'string' && event.data.indexOf(messagePrefix) === 0) {
            instance.runIfPresent(+event.data.slice(messagePrefix.length));
          }
        };
        onGlobalMessage.instance = this;
        root.addEventListener('message', onGlobalMessage, false);
        var fn = function setImmediate() {
          var _a = setImmediate,
              messagePrefix = _a.messagePrefix,
              instance = _a.instance;
          var handle = instance.addFromSetImmediateArguments(arguments);
          instance.root.postMessage(messagePrefix + handle, '*');
          return handle;
        };
        fn.instance = this;
        fn.messagePrefix = messagePrefix;
        return fn;
      };
      ImmediateDefinition.prototype.runIfPresent = function(handle) {
        if (this.currentlyRunningATask) {
          this.root.setTimeout(this.partiallyApplied(this.runIfPresent, handle), 0);
        } else {
          var task = this.tasksByHandle[handle];
          if (task) {
            this.currentlyRunningATask = true;
            try {
              task();
            } finally {
              this.clearImmediate(handle);
              this.currentlyRunningATask = false;
            }
          }
        }
      };
      ImmediateDefinition.prototype.createMessageChannelSetImmediate = function() {
        var _this = this;
        var channel = new this.root.MessageChannel();
        channel.port1.onmessage = function(event) {
          var handle = event.data;
          _this.runIfPresent(handle);
        };
        var fn = function setImmediate() {
          var _a = setImmediate,
              channel = _a.channel,
              instance = _a.instance;
          var handle = instance.addFromSetImmediateArguments(arguments);
          channel.port2.postMessage(handle);
          return handle;
        };
        fn.channel = channel;
        fn.instance = this;
        return fn;
      };
      ImmediateDefinition.prototype.createReadyStateChangeSetImmediate = function() {
        var fn = function setImmediate() {
          var instance = setImmediate.instance;
          var root = instance.root;
          var doc = root.document;
          var html = doc.documentElement;
          var handle = instance.addFromSetImmediateArguments(arguments);
          var script = doc.createElement('script');
          script.onreadystatechange = function() {
            instance.runIfPresent(handle);
            script.onreadystatechange = null;
            html.removeChild(script);
            script = null;
          };
          html.appendChild(script);
          return handle;
        };
        fn.instance = this;
        return fn;
      };
      ImmediateDefinition.prototype.createSetTimeoutSetImmediate = function() {
        var fn = function setImmediate() {
          var instance = setImmediate.instance;
          var handle = instance.addFromSetImmediateArguments(arguments);
          instance.root.setTimeout(instance.partiallyApplied(instance.runIfPresent, handle), 0);
          return handle;
        };
        fn.instance = this;
        return fn;
      };
      return ImmediateDefinition;
    })();
    exports.ImmediateDefinition = ImmediateDefinition;
    exports.Immediate = new ImmediateDefinition(root_1.root);
  })($__require('43'));
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("f3", ["f2", "f4"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var __extends = (this && this.__extends) || function(d, b) {
    for (var p in b)
      if (b.hasOwnProperty(p))
        d[p] = b[p];
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
  var Immediate_1 = $__require('f2');
  var QueueAction_1 = $__require('f4');
  var AsapAction = (function(_super) {
    __extends(AsapAction, _super);
    function AsapAction() {
      _super.apply(this, arguments);
    }
    AsapAction.prototype.schedule = function(state) {
      var _this = this;
      if (this.isUnsubscribed) {
        return this;
      }
      this.state = state;
      var scheduler = this.scheduler;
      scheduler.actions.push(this);
      if (!scheduler.scheduled) {
        scheduler.scheduled = true;
        this.id = Immediate_1.Immediate.setImmediate(function() {
          _this.id = null;
          _this.scheduler.scheduled = false;
          _this.scheduler.flush();
        });
      }
      return this;
    };
    AsapAction.prototype.unsubscribe = function() {
      var id = this.id;
      var scheduler = this.scheduler;
      _super.prototype.unsubscribe.call(this);
      if (scheduler.actions.length === 0) {
        scheduler.active = false;
        scheduler.scheduled = false;
      }
      if (id) {
        this.id = null;
        Immediate_1.Immediate.clearImmediate(id);
      }
    };
    return AsapAction;
  })(QueueAction_1.QueueAction);
  exports.AsapAction = AsapAction;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("f5", ["f6", "f3", "f4"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var __extends = (this && this.__extends) || function(d, b) {
    for (var p in b)
      if (b.hasOwnProperty(p))
        d[p] = b[p];
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
  var QueueScheduler_1 = $__require('f6');
  var AsapAction_1 = $__require('f3');
  var QueueAction_1 = $__require('f4');
  var AsapScheduler = (function(_super) {
    __extends(AsapScheduler, _super);
    function AsapScheduler() {
      _super.apply(this, arguments);
    }
    AsapScheduler.prototype.scheduleNow = function(work, state) {
      return (this.scheduled ? new QueueAction_1.QueueAction(this, work) : new AsapAction_1.AsapAction(this, work)).schedule(state);
    };
    return AsapScheduler;
  })(QueueScheduler_1.QueueScheduler);
  exports.AsapScheduler = AsapScheduler;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("2b", ["f5"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var AsapScheduler_1 = $__require('f5');
  exports.asap = new AsapScheduler_1.AsapScheduler();
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("2e", [], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  function noop() {}
  exports.noop = noop;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("24", ["2e"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var noop_1 = $__require('2e');
  var Subscription = (function() {
    function Subscription(_unsubscribe) {
      this.isUnsubscribed = false;
      if (_unsubscribe) {
        this._unsubscribe = _unsubscribe;
      }
    }
    Subscription.prototype._unsubscribe = function() {
      noop_1.noop();
    };
    Subscription.prototype.unsubscribe = function() {
      if (this.isUnsubscribed) {
        return;
      }
      this.isUnsubscribed = true;
      var unsubscribe = this._unsubscribe;
      var subscriptions = this._subscriptions;
      this._subscriptions = void 0;
      if (unsubscribe) {
        unsubscribe.call(this);
      }
      if (subscriptions != null) {
        var index = -1;
        var len = subscriptions.length;
        while (++index < len) {
          subscriptions[index].unsubscribe();
        }
      }
    };
    Subscription.prototype.add = function(subscription) {
      if (!subscription || (subscription === this) || (subscription === Subscription.EMPTY)) {
        return;
      }
      var sub = subscription;
      switch (typeof subscription) {
        case 'function':
          sub = new Subscription(subscription);
        case 'object':
          if (sub.isUnsubscribed || typeof sub.unsubscribe !== 'function') {
            break;
          } else if (this.isUnsubscribed) {
            sub.unsubscribe();
          } else {
            var subscriptions = this._subscriptions || (this._subscriptions = []);
            subscriptions.push(sub);
          }
          break;
        default:
          throw new Error('Unrecognized subscription ' + subscription + ' added to Subscription.');
      }
    };
    Subscription.prototype.remove = function(subscription) {
      if (subscription == null || (subscription === this) || (subscription === Subscription.EMPTY)) {
        return;
      }
      var subscriptions = this._subscriptions;
      if (subscriptions) {
        var subscriptionIndex = subscriptions.indexOf(subscription);
        if (subscriptionIndex !== -1) {
          subscriptions.splice(subscriptionIndex, 1);
        }
      }
    };
    Subscription.EMPTY = (function(empty) {
      empty.isUnsubscribed = true;
      return empty;
    }(new Subscription()));
    return Subscription;
  })();
  exports.Subscription = Subscription;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("f4", ["24"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var __extends = (this && this.__extends) || function(d, b) {
    for (var p in b)
      if (b.hasOwnProperty(p))
        d[p] = b[p];
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
  var Subscription_1 = $__require('24');
  var QueueAction = (function(_super) {
    __extends(QueueAction, _super);
    function QueueAction(scheduler, work) {
      _super.call(this);
      this.scheduler = scheduler;
      this.work = work;
    }
    QueueAction.prototype.schedule = function(state) {
      if (this.isUnsubscribed) {
        return this;
      }
      this.state = state;
      var scheduler = this.scheduler;
      scheduler.actions.push(this);
      scheduler.flush();
      return this;
    };
    QueueAction.prototype.execute = function() {
      if (this.isUnsubscribed) {
        throw new Error('How did did we execute a canceled Action?');
      }
      this.work(this.state);
    };
    QueueAction.prototype.unsubscribe = function() {
      var scheduler = this.scheduler;
      var actions = scheduler.actions;
      var index = actions.indexOf(this);
      this.work = void 0;
      this.state = void 0;
      this.scheduler = void 0;
      if (index !== -1) {
        actions.splice(index, 1);
      }
      _super.prototype.unsubscribe.call(this);
    };
    return QueueAction;
  })(Subscription_1.Subscription);
  exports.QueueAction = QueueAction;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("f7", ["f4"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var __extends = (this && this.__extends) || function(d, b) {
    for (var p in b)
      if (b.hasOwnProperty(p))
        d[p] = b[p];
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
  var QueueAction_1 = $__require('f4');
  var FutureAction = (function(_super) {
    __extends(FutureAction, _super);
    function FutureAction(scheduler, work) {
      _super.call(this, scheduler, work);
      this.scheduler = scheduler;
      this.work = work;
    }
    FutureAction.prototype.schedule = function(state, delay) {
      var _this = this;
      if (delay === void 0) {
        delay = 0;
      }
      if (this.isUnsubscribed) {
        return this;
      }
      this.delay = delay;
      this.state = state;
      var id = this.id;
      if (id != null) {
        this.id = undefined;
        clearTimeout(id);
      }
      var scheduler = this.scheduler;
      this.id = setTimeout(function() {
        _this.id = void 0;
        scheduler.actions.push(_this);
        scheduler.flush();
      }, this.delay);
      return this;
    };
    FutureAction.prototype.unsubscribe = function() {
      var id = this.id;
      if (id != null) {
        this.id = void 0;
        clearTimeout(id);
      }
      _super.prototype.unsubscribe.call(this);
    };
    return FutureAction;
  })(QueueAction_1.QueueAction);
  exports.FutureAction = FutureAction;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("f6", ["f4", "f7"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var QueueAction_1 = $__require('f4');
  var FutureAction_1 = $__require('f7');
  var QueueScheduler = (function() {
    function QueueScheduler() {
      this.actions = [];
      this.active = false;
      this.scheduled = false;
    }
    QueueScheduler.prototype.now = function() {
      return Date.now();
    };
    QueueScheduler.prototype.flush = function() {
      if (this.active || this.scheduled) {
        return;
      }
      this.active = true;
      var actions = this.actions;
      for (var action = void 0; action = actions.shift(); ) {
        action.execute();
      }
      this.active = false;
    };
    QueueScheduler.prototype.schedule = function(work, delay, state) {
      if (delay === void 0) {
        delay = 0;
      }
      return (delay <= 0) ? this.scheduleNow(work, state) : this.scheduleLater(work, delay, state);
    };
    QueueScheduler.prototype.scheduleNow = function(work, state) {
      return new QueueAction_1.QueueAction(this, work).schedule(state);
    };
    QueueScheduler.prototype.scheduleLater = function(work, delay, state) {
      return new FutureAction_1.FutureAction(this, work).schedule(state, delay);
    };
    return QueueScheduler;
  })();
  exports.QueueScheduler = QueueScheduler;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("20", ["f6"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var QueueScheduler_1 = $__require('f6');
  exports.queue = new QueueScheduler_1.QueueScheduler();
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("1c", [], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var objectTypes = {
    'boolean': false,
    'function': true,
    'object': true,
    'number': false,
    'string': false,
    'undefined': false
  };
  exports.root = (objectTypes[typeof self] && self) || (objectTypes[typeof window] && window);
  var freeExports = objectTypes[typeof exports] && exports && !exports.nodeType && exports;
  var freeModule = objectTypes[typeof module] && module && !module.nodeType && module;
  var freeGlobal = objectTypes[typeof global] && global;
  if (freeGlobal && (freeGlobal.global === freeGlobal || freeGlobal.window === freeGlobal)) {
    exports.root = freeGlobal;
  }
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("1d", ["1c"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var root_1 = $__require('1c');
  function polyfillSymbol(root) {
    var Symbol = ensureSymbol(root);
    ensureIterator(Symbol, root);
    ensureObservable(Symbol);
    ensureFor(Symbol);
    return Symbol;
  }
  exports.polyfillSymbol = polyfillSymbol;
  function ensureFor(Symbol) {
    if (!Symbol.for) {
      Symbol.for = symbolForPolyfill;
    }
  }
  exports.ensureFor = ensureFor;
  var id = 0;
  function ensureSymbol(root) {
    if (!root.Symbol) {
      root.Symbol = function symbolFuncPolyfill(description) {
        return "@@Symbol(" + description + "):" + id++;
      };
    }
    return root.Symbol;
  }
  exports.ensureSymbol = ensureSymbol;
  function symbolForPolyfill(key) {
    return '@@' + key;
  }
  exports.symbolForPolyfill = symbolForPolyfill;
  function ensureIterator(Symbol, root) {
    if (!Symbol.iterator) {
      if (typeof Symbol.for === 'function') {
        Symbol.iterator = Symbol.for('iterator');
      } else if (root.Set && typeof new root.Set()['@@iterator'] === 'function') {
        Symbol.iterator = '@@iterator';
      } else if (root.Map) {
        var keys = Object.getOwnPropertyNames(root.Map.prototype);
        for (var i = 0; i < keys.length; ++i) {
          var key = keys[i];
          if (key !== 'entries' && key !== 'size' && root.Map.prototype[key] === root.Map.prototype['entries']) {
            Symbol.iterator = key;
            break;
          }
        }
      } else {
        Symbol.iterator = '@@iterator';
      }
    }
  }
  exports.ensureIterator = ensureIterator;
  function ensureObservable(Symbol) {
    if (!Symbol.observable) {
      if (typeof Symbol.for === 'function') {
        Symbol.observable = Symbol.for('observable');
      } else {
        Symbol.observable = '@@observable';
      }
    }
  }
  exports.ensureObservable = ensureObservable;
  exports.SymbolShim = polyfillSymbol(root_1.root);
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("eb", ["1d"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var SymbolShim_1 = $__require('1d');
  exports.rxSubscriber = SymbolShim_1.SymbolShim.for('rxSubscriber');
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("f8", ["78", "8", "7", "9", "b", "11", "13", "14", "1a", "21", "22", "25", "27", "28", "2c", "2f", "31", "32", "36", "37", "3b", "3d", "3f", "41", "44", "46", "48", "4c", "4f", "51", "54", "57", "59", "5b", "5d", "5f", "61", "64", "66", "68", "6b", "6c", "6f", "72", "79", "7b", "7e", "80", "82", "84", "86", "88", "8a", "8c", "8e", "8f", "92", "95", "97", "9a", "9d", "9f", "a2", "a4", "a6", "a8", "aa", "ac", "ae", "b1", "b3", "b5", "b7", "b9", "bb", "be", "c0", "c2", "c4", "c7", "c9", "cb", "cd", "cf", "d1", "d3", "d5", "d7", "d9", "db", "dd", "df", "e1", "e3", "e6", "e9", "24", "17", "10", "9c", "99", "af", "63", "71", "c6", "ed", "2b", "20", "eb"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Subject_1 = $__require('78');
  exports.Subject = Subject_1.Subject;
  var Observable_1 = $__require('8');
  exports.Observable = Observable_1.Observable;
  $__require('7');
  $__require('9');
  $__require('b');
  $__require('11');
  $__require('13');
  $__require('14');
  $__require('1a');
  $__require('21');
  $__require('22');
  $__require('25');
  $__require('27');
  $__require('28');
  $__require('2c');
  $__require('2f');
  $__require('31');
  $__require('32');
  $__require('36');
  $__require('37');
  $__require('3b');
  $__require('3d');
  $__require('3f');
  $__require('41');
  $__require('44');
  $__require('46');
  $__require('48');
  $__require('4c');
  $__require('4f');
  $__require('51');
  $__require('54');
  $__require('57');
  $__require('59');
  $__require('5b');
  $__require('5d');
  $__require('5f');
  $__require('61');
  $__require('64');
  $__require('66');
  $__require('68');
  $__require('6b');
  $__require('6c');
  $__require('6f');
  $__require('72');
  $__require('79');
  $__require('7b');
  $__require('7e');
  $__require('80');
  $__require('82');
  $__require('84');
  $__require('86');
  $__require('88');
  $__require('8a');
  $__require('8c');
  $__require('8e');
  $__require('8f');
  $__require('92');
  $__require('95');
  $__require('97');
  $__require('9a');
  $__require('9d');
  $__require('9f');
  $__require('a2');
  $__require('a4');
  $__require('a6');
  $__require('a8');
  $__require('aa');
  $__require('ac');
  $__require('ae');
  $__require('b1');
  $__require('b3');
  $__require('b5');
  $__require('b7');
  $__require('b9');
  $__require('bb');
  $__require('be');
  $__require('c0');
  $__require('c2');
  $__require('c4');
  $__require('c7');
  $__require('c9');
  $__require('cb');
  $__require('cd');
  $__require('cf');
  $__require('d1');
  $__require('d3');
  $__require('d5');
  $__require('d7');
  $__require('d9');
  $__require('db');
  $__require('dd');
  $__require('df');
  $__require('e1');
  $__require('e3');
  $__require('e6');
  $__require('e9');
  var Subscription_1 = $__require('24');
  exports.Subscription = Subscription_1.Subscription;
  var Subscriber_1 = $__require('17');
  exports.Subscriber = Subscriber_1.Subscriber;
  var AsyncSubject_1 = $__require('10');
  exports.AsyncSubject = AsyncSubject_1.AsyncSubject;
  var ReplaySubject_1 = $__require('9c');
  exports.ReplaySubject = ReplaySubject_1.ReplaySubject;
  var BehaviorSubject_1 = $__require('99');
  exports.BehaviorSubject = BehaviorSubject_1.BehaviorSubject;
  var ConnectableObservable_1 = $__require('af');
  exports.ConnectableObservable = ConnectableObservable_1.ConnectableObservable;
  var Notification_1 = $__require('63');
  exports.Notification = Notification_1.Notification;
  var EmptyError_1 = $__require('71');
  exports.EmptyError = EmptyError_1.EmptyError;
  var ArgumentOutOfRangeError_1 = $__require('c6');
  exports.ArgumentOutOfRangeError = ArgumentOutOfRangeError_1.ArgumentOutOfRangeError;
  var ObjectUnsubscribedError_1 = $__require('ed');
  exports.ObjectUnsubscribedError = ObjectUnsubscribedError_1.ObjectUnsubscribedError;
  var asap_1 = $__require('2b');
  var queue_1 = $__require('20');
  var rxSubscriber_1 = $__require('eb');
  var Scheduler = {
    asap: asap_1.asap,
    queue: queue_1.queue
  };
  exports.Scheduler = Scheduler;
  var Symbol = {rxSubscriber: rxSubscriber_1.rxSubscriber};
  exports.Symbol = Symbol;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("f9", ["f8"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = $__require('f8');
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("fa", [], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var lookup = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  ;
  (function(exports) {
    'use strict';
    var Arr = (typeof Uint8Array !== 'undefined') ? Uint8Array : Array;
    var PLUS = '+'.charCodeAt(0);
    var SLASH = '/'.charCodeAt(0);
    var NUMBER = '0'.charCodeAt(0);
    var LOWER = 'a'.charCodeAt(0);
    var UPPER = 'A'.charCodeAt(0);
    var PLUS_URL_SAFE = '-'.charCodeAt(0);
    var SLASH_URL_SAFE = '_'.charCodeAt(0);
    function decode(elt) {
      var code = elt.charCodeAt(0);
      if (code === PLUS || code === PLUS_URL_SAFE)
        return 62;
      if (code === SLASH || code === SLASH_URL_SAFE)
        return 63;
      if (code < NUMBER)
        return -1;
      if (code < NUMBER + 10)
        return code - NUMBER + 26 + 26;
      if (code < UPPER + 26)
        return code - UPPER;
      if (code < LOWER + 26)
        return code - LOWER + 26;
    }
    function b64ToByteArray(b64) {
      var i,
          j,
          l,
          tmp,
          placeHolders,
          arr;
      if (b64.length % 4 > 0) {
        throw new Error('Invalid string. Length must be a multiple of 4');
      }
      var len = b64.length;
      placeHolders = '=' === b64.charAt(len - 2) ? 2 : '=' === b64.charAt(len - 1) ? 1 : 0;
      arr = new Arr(b64.length * 3 / 4 - placeHolders);
      l = placeHolders > 0 ? b64.length - 4 : b64.length;
      var L = 0;
      function push(v) {
        arr[L++] = v;
      }
      for (i = 0, j = 0; i < l; i += 4, j += 3) {
        tmp = (decode(b64.charAt(i)) << 18) | (decode(b64.charAt(i + 1)) << 12) | (decode(b64.charAt(i + 2)) << 6) | decode(b64.charAt(i + 3));
        push((tmp & 0xFF0000) >> 16);
        push((tmp & 0xFF00) >> 8);
        push(tmp & 0xFF);
      }
      if (placeHolders === 2) {
        tmp = (decode(b64.charAt(i)) << 2) | (decode(b64.charAt(i + 1)) >> 4);
        push(tmp & 0xFF);
      } else if (placeHolders === 1) {
        tmp = (decode(b64.charAt(i)) << 10) | (decode(b64.charAt(i + 1)) << 4) | (decode(b64.charAt(i + 2)) >> 2);
        push((tmp >> 8) & 0xFF);
        push(tmp & 0xFF);
      }
      return arr;
    }
    function uint8ToBase64(uint8) {
      var i,
          extraBytes = uint8.length % 3,
          output = "",
          temp,
          length;
      function encode(num) {
        return lookup.charAt(num);
      }
      function tripletToBase64(num) {
        return encode(num >> 18 & 0x3F) + encode(num >> 12 & 0x3F) + encode(num >> 6 & 0x3F) + encode(num & 0x3F);
      }
      for (i = 0, length = uint8.length - extraBytes; i < length; i += 3) {
        temp = (uint8[i] << 16) + (uint8[i + 1] << 8) + (uint8[i + 2]);
        output += tripletToBase64(temp);
      }
      switch (extraBytes) {
        case 1:
          temp = uint8[uint8.length - 1];
          output += encode(temp >> 2);
          output += encode((temp << 4) & 0x3F);
          output += '==';
          break;
        case 2:
          temp = (uint8[uint8.length - 2] << 8) + (uint8[uint8.length - 1]);
          output += encode(temp >> 10);
          output += encode((temp >> 4) & 0x3F);
          output += encode((temp << 2) & 0x3F);
          output += '=';
          break;
      }
      return output;
    }
    exports.toByteArray = b64ToByteArray;
    exports.fromByteArray = uint8ToBase64;
  }(typeof exports === 'undefined' ? (this.base64js = {}) : exports));
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("fb", ["fa"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = $__require('fa');
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("fc", [], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  exports.read = function(buffer, offset, isLE, mLen, nBytes) {
    var e,
        m;
    var eLen = nBytes * 8 - mLen - 1;
    var eMax = (1 << eLen) - 1;
    var eBias = eMax >> 1;
    var nBits = -7;
    var i = isLE ? (nBytes - 1) : 0;
    var d = isLE ? -1 : 1;
    var s = buffer[offset + i];
    i += d;
    e = s & ((1 << (-nBits)) - 1);
    s >>= (-nBits);
    nBits += eLen;
    for (; nBits > 0; e = e * 256 + buffer[offset + i], i += d, nBits -= 8) {}
    m = e & ((1 << (-nBits)) - 1);
    e >>= (-nBits);
    nBits += mLen;
    for (; nBits > 0; m = m * 256 + buffer[offset + i], i += d, nBits -= 8) {}
    if (e === 0) {
      e = 1 - eBias;
    } else if (e === eMax) {
      return m ? NaN : ((s ? -1 : 1) * Infinity);
    } else {
      m = m + Math.pow(2, mLen);
      e = e - eBias;
    }
    return (s ? -1 : 1) * m * Math.pow(2, e - mLen);
  };
  exports.write = function(buffer, value, offset, isLE, mLen, nBytes) {
    var e,
        m,
        c;
    var eLen = nBytes * 8 - mLen - 1;
    var eMax = (1 << eLen) - 1;
    var eBias = eMax >> 1;
    var rt = (mLen === 23 ? Math.pow(2, -24) - Math.pow(2, -77) : 0);
    var i = isLE ? 0 : (nBytes - 1);
    var d = isLE ? 1 : -1;
    var s = value < 0 || (value === 0 && 1 / value < 0) ? 1 : 0;
    value = Math.abs(value);
    if (isNaN(value) || value === Infinity) {
      m = isNaN(value) ? 1 : 0;
      e = eMax;
    } else {
      e = Math.floor(Math.log(value) / Math.LN2);
      if (value * (c = Math.pow(2, -e)) < 1) {
        e--;
        c *= 2;
      }
      if (e + eBias >= 1) {
        value += rt / c;
      } else {
        value += rt * Math.pow(2, 1 - eBias);
      }
      if (value * c >= 2) {
        e++;
        c /= 2;
      }
      if (e + eBias >= eMax) {
        m = 0;
        e = eMax;
      } else if (e + eBias >= 1) {
        m = (value * c - 1) * Math.pow(2, mLen);
        e = e + eBias;
      } else {
        m = value * Math.pow(2, eBias - 1) * Math.pow(2, mLen);
        e = 0;
      }
    }
    for (; mLen >= 8; buffer[offset + i] = m & 0xff, i += d, m /= 256, mLen -= 8) {}
    e = (e << mLen) | m;
    eLen += mLen;
    for (; eLen > 0; buffer[offset + i] = e & 0xff, i += d, e /= 256, eLen -= 8) {}
    buffer[offset + i - d] |= s * 128;
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("fd", ["fc"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = $__require('fc');
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("fe", [], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var toString = {}.toString;
  module.exports = Array.isArray || function(arr) {
    return toString.call(arr) == '[object Array]';
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("ff", ["fe"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = $__require('fe');
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("100", ["fb", "fd", "ff"], true, function($__require, exports, module) {
  "use strict";
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var base64 = $__require('fb');
  var ieee754 = $__require('fd');
  var isArray = $__require('ff');
  exports.Buffer = Buffer;
  exports.SlowBuffer = SlowBuffer;
  exports.INSPECT_MAX_BYTES = 50;
  Buffer.poolSize = 8192;
  var rootParent = {};
  Buffer.TYPED_ARRAY_SUPPORT = global.TYPED_ARRAY_SUPPORT !== undefined ? global.TYPED_ARRAY_SUPPORT : typedArraySupport();
  function typedArraySupport() {
    function Bar() {}
    try {
      var arr = new Uint8Array(1);
      arr.foo = function() {
        return 42;
      };
      arr.constructor = Bar;
      return arr.foo() === 42 && arr.constructor === Bar && typeof arr.subarray === 'function' && arr.subarray(1, 1).byteLength === 0;
    } catch (e) {
      return false;
    }
  }
  function kMaxLength() {
    return Buffer.TYPED_ARRAY_SUPPORT ? 0x7fffffff : 0x3fffffff;
  }
  function Buffer(arg) {
    if (!(this instanceof Buffer)) {
      if (arguments.length > 1)
        return new Buffer(arg, arguments[1]);
      return new Buffer(arg);
    }
    if (!Buffer.TYPED_ARRAY_SUPPORT) {
      this.length = 0;
      this.parent = undefined;
    }
    if (typeof arg === 'number') {
      return fromNumber(this, arg);
    }
    if (typeof arg === 'string') {
      return fromString(this, arg, arguments.length > 1 ? arguments[1] : 'utf8');
    }
    return fromObject(this, arg);
  }
  function fromNumber(that, length) {
    that = allocate(that, length < 0 ? 0 : checked(length) | 0);
    if (!Buffer.TYPED_ARRAY_SUPPORT) {
      for (var i = 0; i < length; i++) {
        that[i] = 0;
      }
    }
    return that;
  }
  function fromString(that, string, encoding) {
    if (typeof encoding !== 'string' || encoding === '')
      encoding = 'utf8';
    var length = byteLength(string, encoding) | 0;
    that = allocate(that, length);
    that.write(string, encoding);
    return that;
  }
  function fromObject(that, object) {
    if (Buffer.isBuffer(object))
      return fromBuffer(that, object);
    if (isArray(object))
      return fromArray(that, object);
    if (object == null) {
      throw new TypeError('must start with number, buffer, array or string');
    }
    if (typeof ArrayBuffer !== 'undefined') {
      if (object.buffer instanceof ArrayBuffer) {
        return fromTypedArray(that, object);
      }
      if (object instanceof ArrayBuffer) {
        return fromArrayBuffer(that, object);
      }
    }
    if (object.length)
      return fromArrayLike(that, object);
    return fromJsonObject(that, object);
  }
  function fromBuffer(that, buffer) {
    var length = checked(buffer.length) | 0;
    that = allocate(that, length);
    buffer.copy(that, 0, 0, length);
    return that;
  }
  function fromArray(that, array) {
    var length = checked(array.length) | 0;
    that = allocate(that, length);
    for (var i = 0; i < length; i += 1) {
      that[i] = array[i] & 255;
    }
    return that;
  }
  function fromTypedArray(that, array) {
    var length = checked(array.length) | 0;
    that = allocate(that, length);
    for (var i = 0; i < length; i += 1) {
      that[i] = array[i] & 255;
    }
    return that;
  }
  function fromArrayBuffer(that, array) {
    if (Buffer.TYPED_ARRAY_SUPPORT) {
      array.byteLength;
      that = Buffer._augment(new Uint8Array(array));
    } else {
      that = fromTypedArray(that, new Uint8Array(array));
    }
    return that;
  }
  function fromArrayLike(that, array) {
    var length = checked(array.length) | 0;
    that = allocate(that, length);
    for (var i = 0; i < length; i += 1) {
      that[i] = array[i] & 255;
    }
    return that;
  }
  function fromJsonObject(that, object) {
    var array;
    var length = 0;
    if (object.type === 'Buffer' && isArray(object.data)) {
      array = object.data;
      length = checked(array.length) | 0;
    }
    that = allocate(that, length);
    for (var i = 0; i < length; i += 1) {
      that[i] = array[i] & 255;
    }
    return that;
  }
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    Buffer.prototype.__proto__ = Uint8Array.prototype;
    Buffer.__proto__ = Uint8Array;
  } else {
    Buffer.prototype.length = undefined;
    Buffer.prototype.parent = undefined;
  }
  function allocate(that, length) {
    if (Buffer.TYPED_ARRAY_SUPPORT) {
      that = Buffer._augment(new Uint8Array(length));
      that.__proto__ = Buffer.prototype;
    } else {
      that.length = length;
      that._isBuffer = true;
    }
    var fromPool = length !== 0 && length <= Buffer.poolSize >>> 1;
    if (fromPool)
      that.parent = rootParent;
    return that;
  }
  function checked(length) {
    if (length >= kMaxLength()) {
      throw new RangeError('Attempt to allocate Buffer larger than maximum ' + 'size: 0x' + kMaxLength().toString(16) + ' bytes');
    }
    return length | 0;
  }
  function SlowBuffer(subject, encoding) {
    if (!(this instanceof SlowBuffer))
      return new SlowBuffer(subject, encoding);
    var buf = new Buffer(subject, encoding);
    delete buf.parent;
    return buf;
  }
  Buffer.isBuffer = function isBuffer(b) {
    return !!(b != null && b._isBuffer);
  };
  Buffer.compare = function compare(a, b) {
    if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b)) {
      throw new TypeError('Arguments must be Buffers');
    }
    if (a === b)
      return 0;
    var x = a.length;
    var y = b.length;
    var i = 0;
    var len = Math.min(x, y);
    while (i < len) {
      if (a[i] !== b[i])
        break;
      ++i;
    }
    if (i !== len) {
      x = a[i];
      y = b[i];
    }
    if (x < y)
      return -1;
    if (y < x)
      return 1;
    return 0;
  };
  Buffer.isEncoding = function isEncoding(encoding) {
    switch (String(encoding).toLowerCase()) {
      case 'hex':
      case 'utf8':
      case 'utf-8':
      case 'ascii':
      case 'binary':
      case 'base64':
      case 'raw':
      case 'ucs2':
      case 'ucs-2':
      case 'utf16le':
      case 'utf-16le':
        return true;
      default:
        return false;
    }
  };
  Buffer.concat = function concat(list, length) {
    if (!isArray(list))
      throw new TypeError('list argument must be an Array of Buffers.');
    if (list.length === 0) {
      return new Buffer(0);
    }
    var i;
    if (length === undefined) {
      length = 0;
      for (i = 0; i < list.length; i++) {
        length += list[i].length;
      }
    }
    var buf = new Buffer(length);
    var pos = 0;
    for (i = 0; i < list.length; i++) {
      var item = list[i];
      item.copy(buf, pos);
      pos += item.length;
    }
    return buf;
  };
  function byteLength(string, encoding) {
    if (typeof string !== 'string')
      string = '' + string;
    var len = string.length;
    if (len === 0)
      return 0;
    var loweredCase = false;
    for (; ; ) {
      switch (encoding) {
        case 'ascii':
        case 'binary':
        case 'raw':
        case 'raws':
          return len;
        case 'utf8':
        case 'utf-8':
          return utf8ToBytes(string).length;
        case 'ucs2':
        case 'ucs-2':
        case 'utf16le':
        case 'utf-16le':
          return len * 2;
        case 'hex':
          return len >>> 1;
        case 'base64':
          return base64ToBytes(string).length;
        default:
          if (loweredCase)
            return utf8ToBytes(string).length;
          encoding = ('' + encoding).toLowerCase();
          loweredCase = true;
      }
    }
  }
  Buffer.byteLength = byteLength;
  function slowToString(encoding, start, end) {
    var loweredCase = false;
    start = start | 0;
    end = end === undefined || end === Infinity ? this.length : end | 0;
    if (!encoding)
      encoding = 'utf8';
    if (start < 0)
      start = 0;
    if (end > this.length)
      end = this.length;
    if (end <= start)
      return '';
    while (true) {
      switch (encoding) {
        case 'hex':
          return hexSlice(this, start, end);
        case 'utf8':
        case 'utf-8':
          return utf8Slice(this, start, end);
        case 'ascii':
          return asciiSlice(this, start, end);
        case 'binary':
          return binarySlice(this, start, end);
        case 'base64':
          return base64Slice(this, start, end);
        case 'ucs2':
        case 'ucs-2':
        case 'utf16le':
        case 'utf-16le':
          return utf16leSlice(this, start, end);
        default:
          if (loweredCase)
            throw new TypeError('Unknown encoding: ' + encoding);
          encoding = (encoding + '').toLowerCase();
          loweredCase = true;
      }
    }
  }
  Buffer.prototype.toString = function toString() {
    var length = this.length | 0;
    if (length === 0)
      return '';
    if (arguments.length === 0)
      return utf8Slice(this, 0, length);
    return slowToString.apply(this, arguments);
  };
  Buffer.prototype.equals = function equals(b) {
    if (!Buffer.isBuffer(b))
      throw new TypeError('Argument must be a Buffer');
    if (this === b)
      return true;
    return Buffer.compare(this, b) === 0;
  };
  Buffer.prototype.inspect = function inspect() {
    var str = '';
    var max = exports.INSPECT_MAX_BYTES;
    if (this.length > 0) {
      str = this.toString('hex', 0, max).match(/.{2}/g).join(' ');
      if (this.length > max)
        str += ' ... ';
    }
    return '<Buffer ' + str + '>';
  };
  Buffer.prototype.compare = function compare(b) {
    if (!Buffer.isBuffer(b))
      throw new TypeError('Argument must be a Buffer');
    if (this === b)
      return 0;
    return Buffer.compare(this, b);
  };
  Buffer.prototype.indexOf = function indexOf(val, byteOffset) {
    if (byteOffset > 0x7fffffff)
      byteOffset = 0x7fffffff;
    else if (byteOffset < -0x80000000)
      byteOffset = -0x80000000;
    byteOffset >>= 0;
    if (this.length === 0)
      return -1;
    if (byteOffset >= this.length)
      return -1;
    if (byteOffset < 0)
      byteOffset = Math.max(this.length + byteOffset, 0);
    if (typeof val === 'string') {
      if (val.length === 0)
        return -1;
      return String.prototype.indexOf.call(this, val, byteOffset);
    }
    if (Buffer.isBuffer(val)) {
      return arrayIndexOf(this, val, byteOffset);
    }
    if (typeof val === 'number') {
      if (Buffer.TYPED_ARRAY_SUPPORT && Uint8Array.prototype.indexOf === 'function') {
        return Uint8Array.prototype.indexOf.call(this, val, byteOffset);
      }
      return arrayIndexOf(this, [val], byteOffset);
    }
    function arrayIndexOf(arr, val, byteOffset) {
      var foundIndex = -1;
      for (var i = 0; byteOffset + i < arr.length; i++) {
        if (arr[byteOffset + i] === val[foundIndex === -1 ? 0 : i - foundIndex]) {
          if (foundIndex === -1)
            foundIndex = i;
          if (i - foundIndex + 1 === val.length)
            return byteOffset + foundIndex;
        } else {
          foundIndex = -1;
        }
      }
      return -1;
    }
    throw new TypeError('val must be string, number or Buffer');
  };
  Buffer.prototype.get = function get(offset) {
    console.log('.get() is deprecated. Access using array indexes instead.');
    return this.readUInt8(offset);
  };
  Buffer.prototype.set = function set(v, offset) {
    console.log('.set() is deprecated. Access using array indexes instead.');
    return this.writeUInt8(v, offset);
  };
  function hexWrite(buf, string, offset, length) {
    offset = Number(offset) || 0;
    var remaining = buf.length - offset;
    if (!length) {
      length = remaining;
    } else {
      length = Number(length);
      if (length > remaining) {
        length = remaining;
      }
    }
    var strLen = string.length;
    if (strLen % 2 !== 0)
      throw new Error('Invalid hex string');
    if (length > strLen / 2) {
      length = strLen / 2;
    }
    for (var i = 0; i < length; i++) {
      var parsed = parseInt(string.substr(i * 2, 2), 16);
      if (isNaN(parsed))
        throw new Error('Invalid hex string');
      buf[offset + i] = parsed;
    }
    return i;
  }
  function utf8Write(buf, string, offset, length) {
    return blitBuffer(utf8ToBytes(string, buf.length - offset), buf, offset, length);
  }
  function asciiWrite(buf, string, offset, length) {
    return blitBuffer(asciiToBytes(string), buf, offset, length);
  }
  function binaryWrite(buf, string, offset, length) {
    return asciiWrite(buf, string, offset, length);
  }
  function base64Write(buf, string, offset, length) {
    return blitBuffer(base64ToBytes(string), buf, offset, length);
  }
  function ucs2Write(buf, string, offset, length) {
    return blitBuffer(utf16leToBytes(string, buf.length - offset), buf, offset, length);
  }
  Buffer.prototype.write = function write(string, offset, length, encoding) {
    if (offset === undefined) {
      encoding = 'utf8';
      length = this.length;
      offset = 0;
    } else if (length === undefined && typeof offset === 'string') {
      encoding = offset;
      length = this.length;
      offset = 0;
    } else if (isFinite(offset)) {
      offset = offset | 0;
      if (isFinite(length)) {
        length = length | 0;
        if (encoding === undefined)
          encoding = 'utf8';
      } else {
        encoding = length;
        length = undefined;
      }
    } else {
      var swap = encoding;
      encoding = offset;
      offset = length | 0;
      length = swap;
    }
    var remaining = this.length - offset;
    if (length === undefined || length > remaining)
      length = remaining;
    if ((string.length > 0 && (length < 0 || offset < 0)) || offset > this.length) {
      throw new RangeError('attempt to write outside buffer bounds');
    }
    if (!encoding)
      encoding = 'utf8';
    var loweredCase = false;
    for (; ; ) {
      switch (encoding) {
        case 'hex':
          return hexWrite(this, string, offset, length);
        case 'utf8':
        case 'utf-8':
          return utf8Write(this, string, offset, length);
        case 'ascii':
          return asciiWrite(this, string, offset, length);
        case 'binary':
          return binaryWrite(this, string, offset, length);
        case 'base64':
          return base64Write(this, string, offset, length);
        case 'ucs2':
        case 'ucs-2':
        case 'utf16le':
        case 'utf-16le':
          return ucs2Write(this, string, offset, length);
        default:
          if (loweredCase)
            throw new TypeError('Unknown encoding: ' + encoding);
          encoding = ('' + encoding).toLowerCase();
          loweredCase = true;
      }
    }
  };
  Buffer.prototype.toJSON = function toJSON() {
    return {
      type: 'Buffer',
      data: Array.prototype.slice.call(this._arr || this, 0)
    };
  };
  function base64Slice(buf, start, end) {
    if (start === 0 && end === buf.length) {
      return base64.fromByteArray(buf);
    } else {
      return base64.fromByteArray(buf.slice(start, end));
    }
  }
  function utf8Slice(buf, start, end) {
    end = Math.min(buf.length, end);
    var res = [];
    var i = start;
    while (i < end) {
      var firstByte = buf[i];
      var codePoint = null;
      var bytesPerSequence = (firstByte > 0xEF) ? 4 : (firstByte > 0xDF) ? 3 : (firstByte > 0xBF) ? 2 : 1;
      if (i + bytesPerSequence <= end) {
        var secondByte,
            thirdByte,
            fourthByte,
            tempCodePoint;
        switch (bytesPerSequence) {
          case 1:
            if (firstByte < 0x80) {
              codePoint = firstByte;
            }
            break;
          case 2:
            secondByte = buf[i + 1];
            if ((secondByte & 0xC0) === 0x80) {
              tempCodePoint = (firstByte & 0x1F) << 0x6 | (secondByte & 0x3F);
              if (tempCodePoint > 0x7F) {
                codePoint = tempCodePoint;
              }
            }
            break;
          case 3:
            secondByte = buf[i + 1];
            thirdByte = buf[i + 2];
            if ((secondByte & 0xC0) === 0x80 && (thirdByte & 0xC0) === 0x80) {
              tempCodePoint = (firstByte & 0xF) << 0xC | (secondByte & 0x3F) << 0x6 | (thirdByte & 0x3F);
              if (tempCodePoint > 0x7FF && (tempCodePoint < 0xD800 || tempCodePoint > 0xDFFF)) {
                codePoint = tempCodePoint;
              }
            }
            break;
          case 4:
            secondByte = buf[i + 1];
            thirdByte = buf[i + 2];
            fourthByte = buf[i + 3];
            if ((secondByte & 0xC0) === 0x80 && (thirdByte & 0xC0) === 0x80 && (fourthByte & 0xC0) === 0x80) {
              tempCodePoint = (firstByte & 0xF) << 0x12 | (secondByte & 0x3F) << 0xC | (thirdByte & 0x3F) << 0x6 | (fourthByte & 0x3F);
              if (tempCodePoint > 0xFFFF && tempCodePoint < 0x110000) {
                codePoint = tempCodePoint;
              }
            }
        }
      }
      if (codePoint === null) {
        codePoint = 0xFFFD;
        bytesPerSequence = 1;
      } else if (codePoint > 0xFFFF) {
        codePoint -= 0x10000;
        res.push(codePoint >>> 10 & 0x3FF | 0xD800);
        codePoint = 0xDC00 | codePoint & 0x3FF;
      }
      res.push(codePoint);
      i += bytesPerSequence;
    }
    return decodeCodePointsArray(res);
  }
  var MAX_ARGUMENTS_LENGTH = 0x1000;
  function decodeCodePointsArray(codePoints) {
    var len = codePoints.length;
    if (len <= MAX_ARGUMENTS_LENGTH) {
      return String.fromCharCode.apply(String, codePoints);
    }
    var res = '';
    var i = 0;
    while (i < len) {
      res += String.fromCharCode.apply(String, codePoints.slice(i, i += MAX_ARGUMENTS_LENGTH));
    }
    return res;
  }
  function asciiSlice(buf, start, end) {
    var ret = '';
    end = Math.min(buf.length, end);
    for (var i = start; i < end; i++) {
      ret += String.fromCharCode(buf[i] & 0x7F);
    }
    return ret;
  }
  function binarySlice(buf, start, end) {
    var ret = '';
    end = Math.min(buf.length, end);
    for (var i = start; i < end; i++) {
      ret += String.fromCharCode(buf[i]);
    }
    return ret;
  }
  function hexSlice(buf, start, end) {
    var len = buf.length;
    if (!start || start < 0)
      start = 0;
    if (!end || end < 0 || end > len)
      end = len;
    var out = '';
    for (var i = start; i < end; i++) {
      out += toHex(buf[i]);
    }
    return out;
  }
  function utf16leSlice(buf, start, end) {
    var bytes = buf.slice(start, end);
    var res = '';
    for (var i = 0; i < bytes.length; i += 2) {
      res += String.fromCharCode(bytes[i] + bytes[i + 1] * 256);
    }
    return res;
  }
  Buffer.prototype.slice = function slice(start, end) {
    var len = this.length;
    start = ~~start;
    end = end === undefined ? len : ~~end;
    if (start < 0) {
      start += len;
      if (start < 0)
        start = 0;
    } else if (start > len) {
      start = len;
    }
    if (end < 0) {
      end += len;
      if (end < 0)
        end = 0;
    } else if (end > len) {
      end = len;
    }
    if (end < start)
      end = start;
    var newBuf;
    if (Buffer.TYPED_ARRAY_SUPPORT) {
      newBuf = Buffer._augment(this.subarray(start, end));
    } else {
      var sliceLen = end - start;
      newBuf = new Buffer(sliceLen, undefined);
      for (var i = 0; i < sliceLen; i++) {
        newBuf[i] = this[i + start];
      }
    }
    if (newBuf.length)
      newBuf.parent = this.parent || this;
    return newBuf;
  };
  function checkOffset(offset, ext, length) {
    if ((offset % 1) !== 0 || offset < 0)
      throw new RangeError('offset is not uint');
    if (offset + ext > length)
      throw new RangeError('Trying to access beyond buffer length');
  }
  Buffer.prototype.readUIntLE = function readUIntLE(offset, byteLength, noAssert) {
    offset = offset | 0;
    byteLength = byteLength | 0;
    if (!noAssert)
      checkOffset(offset, byteLength, this.length);
    var val = this[offset];
    var mul = 1;
    var i = 0;
    while (++i < byteLength && (mul *= 0x100)) {
      val += this[offset + i] * mul;
    }
    return val;
  };
  Buffer.prototype.readUIntBE = function readUIntBE(offset, byteLength, noAssert) {
    offset = offset | 0;
    byteLength = byteLength | 0;
    if (!noAssert) {
      checkOffset(offset, byteLength, this.length);
    }
    var val = this[offset + --byteLength];
    var mul = 1;
    while (byteLength > 0 && (mul *= 0x100)) {
      val += this[offset + --byteLength] * mul;
    }
    return val;
  };
  Buffer.prototype.readUInt8 = function readUInt8(offset, noAssert) {
    if (!noAssert)
      checkOffset(offset, 1, this.length);
    return this[offset];
  };
  Buffer.prototype.readUInt16LE = function readUInt16LE(offset, noAssert) {
    if (!noAssert)
      checkOffset(offset, 2, this.length);
    return this[offset] | (this[offset + 1] << 8);
  };
  Buffer.prototype.readUInt16BE = function readUInt16BE(offset, noAssert) {
    if (!noAssert)
      checkOffset(offset, 2, this.length);
    return (this[offset] << 8) | this[offset + 1];
  };
  Buffer.prototype.readUInt32LE = function readUInt32LE(offset, noAssert) {
    if (!noAssert)
      checkOffset(offset, 4, this.length);
    return ((this[offset]) | (this[offset + 1] << 8) | (this[offset + 2] << 16)) + (this[offset + 3] * 0x1000000);
  };
  Buffer.prototype.readUInt32BE = function readUInt32BE(offset, noAssert) {
    if (!noAssert)
      checkOffset(offset, 4, this.length);
    return (this[offset] * 0x1000000) + ((this[offset + 1] << 16) | (this[offset + 2] << 8) | this[offset + 3]);
  };
  Buffer.prototype.readIntLE = function readIntLE(offset, byteLength, noAssert) {
    offset = offset | 0;
    byteLength = byteLength | 0;
    if (!noAssert)
      checkOffset(offset, byteLength, this.length);
    var val = this[offset];
    var mul = 1;
    var i = 0;
    while (++i < byteLength && (mul *= 0x100)) {
      val += this[offset + i] * mul;
    }
    mul *= 0x80;
    if (val >= mul)
      val -= Math.pow(2, 8 * byteLength);
    return val;
  };
  Buffer.prototype.readIntBE = function readIntBE(offset, byteLength, noAssert) {
    offset = offset | 0;
    byteLength = byteLength | 0;
    if (!noAssert)
      checkOffset(offset, byteLength, this.length);
    var i = byteLength;
    var mul = 1;
    var val = this[offset + --i];
    while (i > 0 && (mul *= 0x100)) {
      val += this[offset + --i] * mul;
    }
    mul *= 0x80;
    if (val >= mul)
      val -= Math.pow(2, 8 * byteLength);
    return val;
  };
  Buffer.prototype.readInt8 = function readInt8(offset, noAssert) {
    if (!noAssert)
      checkOffset(offset, 1, this.length);
    if (!(this[offset] & 0x80))
      return (this[offset]);
    return ((0xff - this[offset] + 1) * -1);
  };
  Buffer.prototype.readInt16LE = function readInt16LE(offset, noAssert) {
    if (!noAssert)
      checkOffset(offset, 2, this.length);
    var val = this[offset] | (this[offset + 1] << 8);
    return (val & 0x8000) ? val | 0xFFFF0000 : val;
  };
  Buffer.prototype.readInt16BE = function readInt16BE(offset, noAssert) {
    if (!noAssert)
      checkOffset(offset, 2, this.length);
    var val = this[offset + 1] | (this[offset] << 8);
    return (val & 0x8000) ? val | 0xFFFF0000 : val;
  };
  Buffer.prototype.readInt32LE = function readInt32LE(offset, noAssert) {
    if (!noAssert)
      checkOffset(offset, 4, this.length);
    return (this[offset]) | (this[offset + 1] << 8) | (this[offset + 2] << 16) | (this[offset + 3] << 24);
  };
  Buffer.prototype.readInt32BE = function readInt32BE(offset, noAssert) {
    if (!noAssert)
      checkOffset(offset, 4, this.length);
    return (this[offset] << 24) | (this[offset + 1] << 16) | (this[offset + 2] << 8) | (this[offset + 3]);
  };
  Buffer.prototype.readFloatLE = function readFloatLE(offset, noAssert) {
    if (!noAssert)
      checkOffset(offset, 4, this.length);
    return ieee754.read(this, offset, true, 23, 4);
  };
  Buffer.prototype.readFloatBE = function readFloatBE(offset, noAssert) {
    if (!noAssert)
      checkOffset(offset, 4, this.length);
    return ieee754.read(this, offset, false, 23, 4);
  };
  Buffer.prototype.readDoubleLE = function readDoubleLE(offset, noAssert) {
    if (!noAssert)
      checkOffset(offset, 8, this.length);
    return ieee754.read(this, offset, true, 52, 8);
  };
  Buffer.prototype.readDoubleBE = function readDoubleBE(offset, noAssert) {
    if (!noAssert)
      checkOffset(offset, 8, this.length);
    return ieee754.read(this, offset, false, 52, 8);
  };
  function checkInt(buf, value, offset, ext, max, min) {
    if (!Buffer.isBuffer(buf))
      throw new TypeError('buffer must be a Buffer instance');
    if (value > max || value < min)
      throw new RangeError('value is out of bounds');
    if (offset + ext > buf.length)
      throw new RangeError('index out of range');
  }
  Buffer.prototype.writeUIntLE = function writeUIntLE(value, offset, byteLength, noAssert) {
    value = +value;
    offset = offset | 0;
    byteLength = byteLength | 0;
    if (!noAssert)
      checkInt(this, value, offset, byteLength, Math.pow(2, 8 * byteLength), 0);
    var mul = 1;
    var i = 0;
    this[offset] = value & 0xFF;
    while (++i < byteLength && (mul *= 0x100)) {
      this[offset + i] = (value / mul) & 0xFF;
    }
    return offset + byteLength;
  };
  Buffer.prototype.writeUIntBE = function writeUIntBE(value, offset, byteLength, noAssert) {
    value = +value;
    offset = offset | 0;
    byteLength = byteLength | 0;
    if (!noAssert)
      checkInt(this, value, offset, byteLength, Math.pow(2, 8 * byteLength), 0);
    var i = byteLength - 1;
    var mul = 1;
    this[offset + i] = value & 0xFF;
    while (--i >= 0 && (mul *= 0x100)) {
      this[offset + i] = (value / mul) & 0xFF;
    }
    return offset + byteLength;
  };
  Buffer.prototype.writeUInt8 = function writeUInt8(value, offset, noAssert) {
    value = +value;
    offset = offset | 0;
    if (!noAssert)
      checkInt(this, value, offset, 1, 0xff, 0);
    if (!Buffer.TYPED_ARRAY_SUPPORT)
      value = Math.floor(value);
    this[offset] = (value & 0xff);
    return offset + 1;
  };
  function objectWriteUInt16(buf, value, offset, littleEndian) {
    if (value < 0)
      value = 0xffff + value + 1;
    for (var i = 0,
        j = Math.min(buf.length - offset, 2); i < j; i++) {
      buf[offset + i] = (value & (0xff << (8 * (littleEndian ? i : 1 - i)))) >>> (littleEndian ? i : 1 - i) * 8;
    }
  }
  Buffer.prototype.writeUInt16LE = function writeUInt16LE(value, offset, noAssert) {
    value = +value;
    offset = offset | 0;
    if (!noAssert)
      checkInt(this, value, offset, 2, 0xffff, 0);
    if (Buffer.TYPED_ARRAY_SUPPORT) {
      this[offset] = (value & 0xff);
      this[offset + 1] = (value >>> 8);
    } else {
      objectWriteUInt16(this, value, offset, true);
    }
    return offset + 2;
  };
  Buffer.prototype.writeUInt16BE = function writeUInt16BE(value, offset, noAssert) {
    value = +value;
    offset = offset | 0;
    if (!noAssert)
      checkInt(this, value, offset, 2, 0xffff, 0);
    if (Buffer.TYPED_ARRAY_SUPPORT) {
      this[offset] = (value >>> 8);
      this[offset + 1] = (value & 0xff);
    } else {
      objectWriteUInt16(this, value, offset, false);
    }
    return offset + 2;
  };
  function objectWriteUInt32(buf, value, offset, littleEndian) {
    if (value < 0)
      value = 0xffffffff + value + 1;
    for (var i = 0,
        j = Math.min(buf.length - offset, 4); i < j; i++) {
      buf[offset + i] = (value >>> (littleEndian ? i : 3 - i) * 8) & 0xff;
    }
  }
  Buffer.prototype.writeUInt32LE = function writeUInt32LE(value, offset, noAssert) {
    value = +value;
    offset = offset | 0;
    if (!noAssert)
      checkInt(this, value, offset, 4, 0xffffffff, 0);
    if (Buffer.TYPED_ARRAY_SUPPORT) {
      this[offset + 3] = (value >>> 24);
      this[offset + 2] = (value >>> 16);
      this[offset + 1] = (value >>> 8);
      this[offset] = (value & 0xff);
    } else {
      objectWriteUInt32(this, value, offset, true);
    }
    return offset + 4;
  };
  Buffer.prototype.writeUInt32BE = function writeUInt32BE(value, offset, noAssert) {
    value = +value;
    offset = offset | 0;
    if (!noAssert)
      checkInt(this, value, offset, 4, 0xffffffff, 0);
    if (Buffer.TYPED_ARRAY_SUPPORT) {
      this[offset] = (value >>> 24);
      this[offset + 1] = (value >>> 16);
      this[offset + 2] = (value >>> 8);
      this[offset + 3] = (value & 0xff);
    } else {
      objectWriteUInt32(this, value, offset, false);
    }
    return offset + 4;
  };
  Buffer.prototype.writeIntLE = function writeIntLE(value, offset, byteLength, noAssert) {
    value = +value;
    offset = offset | 0;
    if (!noAssert) {
      var limit = Math.pow(2, 8 * byteLength - 1);
      checkInt(this, value, offset, byteLength, limit - 1, -limit);
    }
    var i = 0;
    var mul = 1;
    var sub = value < 0 ? 1 : 0;
    this[offset] = value & 0xFF;
    while (++i < byteLength && (mul *= 0x100)) {
      this[offset + i] = ((value / mul) >> 0) - sub & 0xFF;
    }
    return offset + byteLength;
  };
  Buffer.prototype.writeIntBE = function writeIntBE(value, offset, byteLength, noAssert) {
    value = +value;
    offset = offset | 0;
    if (!noAssert) {
      var limit = Math.pow(2, 8 * byteLength - 1);
      checkInt(this, value, offset, byteLength, limit - 1, -limit);
    }
    var i = byteLength - 1;
    var mul = 1;
    var sub = value < 0 ? 1 : 0;
    this[offset + i] = value & 0xFF;
    while (--i >= 0 && (mul *= 0x100)) {
      this[offset + i] = ((value / mul) >> 0) - sub & 0xFF;
    }
    return offset + byteLength;
  };
  Buffer.prototype.writeInt8 = function writeInt8(value, offset, noAssert) {
    value = +value;
    offset = offset | 0;
    if (!noAssert)
      checkInt(this, value, offset, 1, 0x7f, -0x80);
    if (!Buffer.TYPED_ARRAY_SUPPORT)
      value = Math.floor(value);
    if (value < 0)
      value = 0xff + value + 1;
    this[offset] = (value & 0xff);
    return offset + 1;
  };
  Buffer.prototype.writeInt16LE = function writeInt16LE(value, offset, noAssert) {
    value = +value;
    offset = offset | 0;
    if (!noAssert)
      checkInt(this, value, offset, 2, 0x7fff, -0x8000);
    if (Buffer.TYPED_ARRAY_SUPPORT) {
      this[offset] = (value & 0xff);
      this[offset + 1] = (value >>> 8);
    } else {
      objectWriteUInt16(this, value, offset, true);
    }
    return offset + 2;
  };
  Buffer.prototype.writeInt16BE = function writeInt16BE(value, offset, noAssert) {
    value = +value;
    offset = offset | 0;
    if (!noAssert)
      checkInt(this, value, offset, 2, 0x7fff, -0x8000);
    if (Buffer.TYPED_ARRAY_SUPPORT) {
      this[offset] = (value >>> 8);
      this[offset + 1] = (value & 0xff);
    } else {
      objectWriteUInt16(this, value, offset, false);
    }
    return offset + 2;
  };
  Buffer.prototype.writeInt32LE = function writeInt32LE(value, offset, noAssert) {
    value = +value;
    offset = offset | 0;
    if (!noAssert)
      checkInt(this, value, offset, 4, 0x7fffffff, -0x80000000);
    if (Buffer.TYPED_ARRAY_SUPPORT) {
      this[offset] = (value & 0xff);
      this[offset + 1] = (value >>> 8);
      this[offset + 2] = (value >>> 16);
      this[offset + 3] = (value >>> 24);
    } else {
      objectWriteUInt32(this, value, offset, true);
    }
    return offset + 4;
  };
  Buffer.prototype.writeInt32BE = function writeInt32BE(value, offset, noAssert) {
    value = +value;
    offset = offset | 0;
    if (!noAssert)
      checkInt(this, value, offset, 4, 0x7fffffff, -0x80000000);
    if (value < 0)
      value = 0xffffffff + value + 1;
    if (Buffer.TYPED_ARRAY_SUPPORT) {
      this[offset] = (value >>> 24);
      this[offset + 1] = (value >>> 16);
      this[offset + 2] = (value >>> 8);
      this[offset + 3] = (value & 0xff);
    } else {
      objectWriteUInt32(this, value, offset, false);
    }
    return offset + 4;
  };
  function checkIEEE754(buf, value, offset, ext, max, min) {
    if (value > max || value < min)
      throw new RangeError('value is out of bounds');
    if (offset + ext > buf.length)
      throw new RangeError('index out of range');
    if (offset < 0)
      throw new RangeError('index out of range');
  }
  function writeFloat(buf, value, offset, littleEndian, noAssert) {
    if (!noAssert) {
      checkIEEE754(buf, value, offset, 4, 3.4028234663852886e+38, -3.4028234663852886e+38);
    }
    ieee754.write(buf, value, offset, littleEndian, 23, 4);
    return offset + 4;
  }
  Buffer.prototype.writeFloatLE = function writeFloatLE(value, offset, noAssert) {
    return writeFloat(this, value, offset, true, noAssert);
  };
  Buffer.prototype.writeFloatBE = function writeFloatBE(value, offset, noAssert) {
    return writeFloat(this, value, offset, false, noAssert);
  };
  function writeDouble(buf, value, offset, littleEndian, noAssert) {
    if (!noAssert) {
      checkIEEE754(buf, value, offset, 8, 1.7976931348623157E+308, -1.7976931348623157E+308);
    }
    ieee754.write(buf, value, offset, littleEndian, 52, 8);
    return offset + 8;
  }
  Buffer.prototype.writeDoubleLE = function writeDoubleLE(value, offset, noAssert) {
    return writeDouble(this, value, offset, true, noAssert);
  };
  Buffer.prototype.writeDoubleBE = function writeDoubleBE(value, offset, noAssert) {
    return writeDouble(this, value, offset, false, noAssert);
  };
  Buffer.prototype.copy = function copy(target, targetStart, start, end) {
    if (!start)
      start = 0;
    if (!end && end !== 0)
      end = this.length;
    if (targetStart >= target.length)
      targetStart = target.length;
    if (!targetStart)
      targetStart = 0;
    if (end > 0 && end < start)
      end = start;
    if (end === start)
      return 0;
    if (target.length === 0 || this.length === 0)
      return 0;
    if (targetStart < 0) {
      throw new RangeError('targetStart out of bounds');
    }
    if (start < 0 || start >= this.length)
      throw new RangeError('sourceStart out of bounds');
    if (end < 0)
      throw new RangeError('sourceEnd out of bounds');
    if (end > this.length)
      end = this.length;
    if (target.length - targetStart < end - start) {
      end = target.length - targetStart + start;
    }
    var len = end - start;
    var i;
    if (this === target && start < targetStart && targetStart < end) {
      for (i = len - 1; i >= 0; i--) {
        target[i + targetStart] = this[i + start];
      }
    } else if (len < 1000 || !Buffer.TYPED_ARRAY_SUPPORT) {
      for (i = 0; i < len; i++) {
        target[i + targetStart] = this[i + start];
      }
    } else {
      target._set(this.subarray(start, start + len), targetStart);
    }
    return len;
  };
  Buffer.prototype.fill = function fill(value, start, end) {
    if (!value)
      value = 0;
    if (!start)
      start = 0;
    if (!end)
      end = this.length;
    if (end < start)
      throw new RangeError('end < start');
    if (end === start)
      return;
    if (this.length === 0)
      return;
    if (start < 0 || start >= this.length)
      throw new RangeError('start out of bounds');
    if (end < 0 || end > this.length)
      throw new RangeError('end out of bounds');
    var i;
    if (typeof value === 'number') {
      for (i = start; i < end; i++) {
        this[i] = value;
      }
    } else {
      var bytes = utf8ToBytes(value.toString());
      var len = bytes.length;
      for (i = start; i < end; i++) {
        this[i] = bytes[i % len];
      }
    }
    return this;
  };
  Buffer.prototype.toArrayBuffer = function toArrayBuffer() {
    if (typeof Uint8Array !== 'undefined') {
      if (Buffer.TYPED_ARRAY_SUPPORT) {
        return (new Buffer(this)).buffer;
      } else {
        var buf = new Uint8Array(this.length);
        for (var i = 0,
            len = buf.length; i < len; i += 1) {
          buf[i] = this[i];
        }
        return buf.buffer;
      }
    } else {
      throw new TypeError('Buffer.toArrayBuffer not supported in this browser');
    }
  };
  var BP = Buffer.prototype;
  Buffer._augment = function _augment(arr) {
    arr.constructor = Buffer;
    arr._isBuffer = true;
    arr._set = arr.set;
    arr.get = BP.get;
    arr.set = BP.set;
    arr.write = BP.write;
    arr.toString = BP.toString;
    arr.toLocaleString = BP.toString;
    arr.toJSON = BP.toJSON;
    arr.equals = BP.equals;
    arr.compare = BP.compare;
    arr.indexOf = BP.indexOf;
    arr.copy = BP.copy;
    arr.slice = BP.slice;
    arr.readUIntLE = BP.readUIntLE;
    arr.readUIntBE = BP.readUIntBE;
    arr.readUInt8 = BP.readUInt8;
    arr.readUInt16LE = BP.readUInt16LE;
    arr.readUInt16BE = BP.readUInt16BE;
    arr.readUInt32LE = BP.readUInt32LE;
    arr.readUInt32BE = BP.readUInt32BE;
    arr.readIntLE = BP.readIntLE;
    arr.readIntBE = BP.readIntBE;
    arr.readInt8 = BP.readInt8;
    arr.readInt16LE = BP.readInt16LE;
    arr.readInt16BE = BP.readInt16BE;
    arr.readInt32LE = BP.readInt32LE;
    arr.readInt32BE = BP.readInt32BE;
    arr.readFloatLE = BP.readFloatLE;
    arr.readFloatBE = BP.readFloatBE;
    arr.readDoubleLE = BP.readDoubleLE;
    arr.readDoubleBE = BP.readDoubleBE;
    arr.writeUInt8 = BP.writeUInt8;
    arr.writeUIntLE = BP.writeUIntLE;
    arr.writeUIntBE = BP.writeUIntBE;
    arr.writeUInt16LE = BP.writeUInt16LE;
    arr.writeUInt16BE = BP.writeUInt16BE;
    arr.writeUInt32LE = BP.writeUInt32LE;
    arr.writeUInt32BE = BP.writeUInt32BE;
    arr.writeIntLE = BP.writeIntLE;
    arr.writeIntBE = BP.writeIntBE;
    arr.writeInt8 = BP.writeInt8;
    arr.writeInt16LE = BP.writeInt16LE;
    arr.writeInt16BE = BP.writeInt16BE;
    arr.writeInt32LE = BP.writeInt32LE;
    arr.writeInt32BE = BP.writeInt32BE;
    arr.writeFloatLE = BP.writeFloatLE;
    arr.writeFloatBE = BP.writeFloatBE;
    arr.writeDoubleLE = BP.writeDoubleLE;
    arr.writeDoubleBE = BP.writeDoubleBE;
    arr.fill = BP.fill;
    arr.inspect = BP.inspect;
    arr.toArrayBuffer = BP.toArrayBuffer;
    return arr;
  };
  var INVALID_BASE64_RE = /[^+\/0-9A-Za-z-_]/g;
  function base64clean(str) {
    str = stringtrim(str).replace(INVALID_BASE64_RE, '');
    if (str.length < 2)
      return '';
    while (str.length % 4 !== 0) {
      str = str + '=';
    }
    return str;
  }
  function stringtrim(str) {
    if (str.trim)
      return str.trim();
    return str.replace(/^\s+|\s+$/g, '');
  }
  function toHex(n) {
    if (n < 16)
      return '0' + n.toString(16);
    return n.toString(16);
  }
  function utf8ToBytes(string, units) {
    units = units || Infinity;
    var codePoint;
    var length = string.length;
    var leadSurrogate = null;
    var bytes = [];
    for (var i = 0; i < length; i++) {
      codePoint = string.charCodeAt(i);
      if (codePoint > 0xD7FF && codePoint < 0xE000) {
        if (!leadSurrogate) {
          if (codePoint > 0xDBFF) {
            if ((units -= 3) > -1)
              bytes.push(0xEF, 0xBF, 0xBD);
            continue;
          } else if (i + 1 === length) {
            if ((units -= 3) > -1)
              bytes.push(0xEF, 0xBF, 0xBD);
            continue;
          }
          leadSurrogate = codePoint;
          continue;
        }
        if (codePoint < 0xDC00) {
          if ((units -= 3) > -1)
            bytes.push(0xEF, 0xBF, 0xBD);
          leadSurrogate = codePoint;
          continue;
        }
        codePoint = (leadSurrogate - 0xD800 << 10 | codePoint - 0xDC00) + 0x10000;
      } else if (leadSurrogate) {
        if ((units -= 3) > -1)
          bytes.push(0xEF, 0xBF, 0xBD);
      }
      leadSurrogate = null;
      if (codePoint < 0x80) {
        if ((units -= 1) < 0)
          break;
        bytes.push(codePoint);
      } else if (codePoint < 0x800) {
        if ((units -= 2) < 0)
          break;
        bytes.push(codePoint >> 0x6 | 0xC0, codePoint & 0x3F | 0x80);
      } else if (codePoint < 0x10000) {
        if ((units -= 3) < 0)
          break;
        bytes.push(codePoint >> 0xC | 0xE0, codePoint >> 0x6 & 0x3F | 0x80, codePoint & 0x3F | 0x80);
      } else if (codePoint < 0x110000) {
        if ((units -= 4) < 0)
          break;
        bytes.push(codePoint >> 0x12 | 0xF0, codePoint >> 0xC & 0x3F | 0x80, codePoint >> 0x6 & 0x3F | 0x80, codePoint & 0x3F | 0x80);
      } else {
        throw new Error('Invalid code point');
      }
    }
    return bytes;
  }
  function asciiToBytes(str) {
    var byteArray = [];
    for (var i = 0; i < str.length; i++) {
      byteArray.push(str.charCodeAt(i) & 0xFF);
    }
    return byteArray;
  }
  function utf16leToBytes(str, units) {
    var c,
        hi,
        lo;
    var byteArray = [];
    for (var i = 0; i < str.length; i++) {
      if ((units -= 2) < 0)
        break;
      c = str.charCodeAt(i);
      hi = c >> 8;
      lo = c % 256;
      byteArray.push(lo);
      byteArray.push(hi);
    }
    return byteArray;
  }
  function base64ToBytes(str) {
    return base64.toByteArray(base64clean(str));
  }
  function blitBuffer(src, dst, offset, length) {
    for (var i = 0; i < length; i++) {
      if ((i + offset >= dst.length) || (i >= src.length))
        break;
      dst[i + offset] = src[i];
    }
    return i;
  }
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("101", ["100"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = $__require('100');
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("102", ["101"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = $__System._nodeRequire ? $__System._nodeRequire('buffer') : $__require('101');
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("3a", ["102"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = $__require('102');
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("103", ["3a"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  (function(Buffer) {
    (function() {
      var g,
          aa = this;
      function n(a) {
        return void 0 !== a;
      }
      function ba() {}
      function ca(a) {
        a.ub = function() {
          return a.uf ? a.uf : a.uf = new a;
        };
      }
      function da(a) {
        var b = typeof a;
        if ("object" == b)
          if (a) {
            if (a instanceof Array)
              return "array";
            if (a instanceof Object)
              return b;
            var c = Object.prototype.toString.call(a);
            if ("[object Window]" == c)
              return "object";
            if ("[object Array]" == c || "number" == typeof a.length && "undefined" != typeof a.splice && "undefined" != typeof a.propertyIsEnumerable && !a.propertyIsEnumerable("splice"))
              return "array";
            if ("[object Function]" == c || "undefined" != typeof a.call && "undefined" != typeof a.propertyIsEnumerable && !a.propertyIsEnumerable("call"))
              return "function";
          } else
            return "null";
        else if ("function" == b && "undefined" == typeof a.call)
          return "object";
        return b;
      }
      function ea(a) {
        return "array" == da(a);
      }
      function fa(a) {
        var b = da(a);
        return "array" == b || "object" == b && "number" == typeof a.length;
      }
      function p(a) {
        return "string" == typeof a;
      }
      function ga(a) {
        return "number" == typeof a;
      }
      function ha(a) {
        return "function" == da(a);
      }
      function ia(a) {
        var b = typeof a;
        return "object" == b && null != a || "function" == b;
      }
      function ja(a, b, c) {
        return a.call.apply(a.bind, arguments);
      }
      function ka(a, b, c) {
        if (!a)
          throw Error();
        if (2 < arguments.length) {
          var d = Array.prototype.slice.call(arguments, 2);
          return function() {
            var c = Array.prototype.slice.call(arguments);
            Array.prototype.unshift.apply(c, d);
            return a.apply(b, c);
          };
        }
        return function() {
          return a.apply(b, arguments);
        };
      }
      function q(a, b, c) {
        q = Function.prototype.bind && -1 != Function.prototype.bind.toString().indexOf("native code") ? ja : ka;
        return q.apply(null, arguments);
      }
      var la = Date.now || function() {
        return +new Date;
      };
      function ma(a, b) {
        function c() {}
        c.prototype = b.prototype;
        a.bh = b.prototype;
        a.prototype = new c;
        a.prototype.constructor = a;
        a.Yg = function(a, c, f) {
          for (var h = Array(arguments.length - 2),
              k = 2; k < arguments.length; k++)
            h[k - 2] = arguments[k];
          return b.prototype[c].apply(a, h);
        };
      }
      ;
      function r(a, b) {
        for (var c in a)
          b.call(void 0, a[c], c, a);
      }
      function na(a, b) {
        var c = {},
            d;
        for (d in a)
          c[d] = b.call(void 0, a[d], d, a);
        return c;
      }
      function oa(a, b) {
        for (var c in a)
          if (!b.call(void 0, a[c], c, a))
            return !1;
        return !0;
      }
      function pa(a) {
        var b = 0,
            c;
        for (c in a)
          b++;
        return b;
      }
      function qa(a) {
        for (var b in a)
          return b;
      }
      function ra(a) {
        var b = [],
            c = 0,
            d;
        for (d in a)
          b[c++] = a[d];
        return b;
      }
      function sa(a) {
        var b = [],
            c = 0,
            d;
        for (d in a)
          b[c++] = d;
        return b;
      }
      function ta(a, b) {
        for (var c in a)
          if (a[c] == b)
            return !0;
        return !1;
      }
      function ua(a, b, c) {
        for (var d in a)
          if (b.call(c, a[d], d, a))
            return d;
      }
      function va(a, b) {
        var c = ua(a, b, void 0);
        return c && a[c];
      }
      function wa(a) {
        for (var b in a)
          return !1;
        return !0;
      }
      function xa(a) {
        var b = {},
            c;
        for (c in a)
          b[c] = a[c];
        return b;
      }
      var ya = "constructor hasOwnProperty isPrototypeOf propertyIsEnumerable toLocaleString toString valueOf".split(" ");
      function za(a, b) {
        for (var c,
            d,
            e = 1; e < arguments.length; e++) {
          d = arguments[e];
          for (c in d)
            a[c] = d[c];
          for (var f = 0; f < ya.length; f++)
            c = ya[f], Object.prototype.hasOwnProperty.call(d, c) && (a[c] = d[c]);
        }
      }
      ;
      function Aa(a) {
        a = String(a);
        if (/^\s*$/.test(a) ? 0 : /^[\],:{}\s\u2028\u2029]*$/.test(a.replace(/\\["\\\/bfnrtu]/g, "@").replace(/"[^"\\\n\r\u2028\u2029\x00-\x08\x0a-\x1f]*"|true|false|null|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?/g, "]").replace(/(?:^|:|,)(?:[\s\u2028\u2029]*\[)+/g, "")))
          try {
            return eval("(" + a + ")");
          } catch (b) {}
        throw Error("Invalid JSON string: " + a);
      }
      function Ba() {
        this.Sd = void 0;
      }
      function Ca(a, b, c) {
        switch (typeof b) {
          case "string":
            Da(b, c);
            break;
          case "number":
            c.push(isFinite(b) && !isNaN(b) ? b : "null");
            break;
          case "boolean":
            c.push(b);
            break;
          case "undefined":
            c.push("null");
            break;
          case "object":
            if (null == b) {
              c.push("null");
              break;
            }
            if (ea(b)) {
              var d = b.length;
              c.push("[");
              for (var e = "",
                  f = 0; f < d; f++)
                c.push(e), e = b[f], Ca(a, a.Sd ? a.Sd.call(b, String(f), e) : e, c), e = ",";
              c.push("]");
              break;
            }
            c.push("{");
            d = "";
            for (f in b)
              Object.prototype.hasOwnProperty.call(b, f) && (e = b[f], "function" != typeof e && (c.push(d), Da(f, c), c.push(":"), Ca(a, a.Sd ? a.Sd.call(b, f, e) : e, c), d = ","));
            c.push("}");
            break;
          case "function":
            break;
          default:
            throw Error("Unknown type: " + typeof b);
        }
      }
      var Ea = {
        '"': '\\"',
        "\\": "\\\\",
        "/": "\\/",
        "\b": "\\b",
        "\f": "\\f",
        "\n": "\\n",
        "\r": "\\r",
        "\t": "\\t",
        "\x0B": "\\u000b"
      },
          Fa = /\uffff/.test("\uffff") ? /[\\\"\x00-\x1f\x7f-\uffff]/g : /[\\\"\x00-\x1f\x7f-\xff]/g;
      function Da(a, b) {
        b.push('"', a.replace(Fa, function(a) {
          if (a in Ea)
            return Ea[a];
          var b = a.charCodeAt(0),
              e = "\\u";
          16 > b ? e += "000" : 256 > b ? e += "00" : 4096 > b && (e += "0");
          return Ea[a] = e + b.toString(16);
        }), '"');
      }
      ;
      function Ga() {
        return Math.floor(2147483648 * Math.random()).toString(36) + Math.abs(Math.floor(2147483648 * Math.random()) ^ la()).toString(36);
      }
      ;
      var Ha;
      a: {
        var Ia = aa.navigator;
        if (Ia) {
          var Ja = Ia.userAgent;
          if (Ja) {
            Ha = Ja;
            break a;
          }
        }
        Ha = "";
      }
      ;
      function Ka() {
        this.Va = -1;
      }
      ;
      function La() {
        this.Va = -1;
        this.Va = 64;
        this.N = [];
        this.me = [];
        this.Wf = [];
        this.Ld = [];
        this.Ld[0] = 128;
        for (var a = 1; a < this.Va; ++a)
          this.Ld[a] = 0;
        this.de = this.ac = 0;
        this.reset();
      }
      ma(La, Ka);
      La.prototype.reset = function() {
        this.N[0] = 1732584193;
        this.N[1] = 4023233417;
        this.N[2] = 2562383102;
        this.N[3] = 271733878;
        this.N[4] = 3285377520;
        this.de = this.ac = 0;
      };
      function Ma(a, b, c) {
        c || (c = 0);
        var d = a.Wf;
        if (p(b))
          for (var e = 0; 16 > e; e++)
            d[e] = b.charCodeAt(c) << 24 | b.charCodeAt(c + 1) << 16 | b.charCodeAt(c + 2) << 8 | b.charCodeAt(c + 3), c += 4;
        else
          for (e = 0; 16 > e; e++)
            d[e] = b[c] << 24 | b[c + 1] << 16 | b[c + 2] << 8 | b[c + 3], c += 4;
        for (e = 16; 80 > e; e++) {
          var f = d[e - 3] ^ d[e - 8] ^ d[e - 14] ^ d[e - 16];
          d[e] = (f << 1 | f >>> 31) & 4294967295;
        }
        b = a.N[0];
        c = a.N[1];
        for (var h = a.N[2],
            k = a.N[3],
            l = a.N[4],
            m,
            e = 0; 80 > e; e++)
          40 > e ? 20 > e ? (f = k ^ c & (h ^ k), m = 1518500249) : (f = c ^ h ^ k, m = 1859775393) : 60 > e ? (f = c & h | k & (c | h), m = 2400959708) : (f = c ^ h ^ k, m = 3395469782), f = (b << 5 | b >>> 27) + f + l + m + d[e] & 4294967295, l = k, k = h, h = (c << 30 | c >>> 2) & 4294967295, c = b, b = f;
        a.N[0] = a.N[0] + b & 4294967295;
        a.N[1] = a.N[1] + c & 4294967295;
        a.N[2] = a.N[2] + h & 4294967295;
        a.N[3] = a.N[3] + k & 4294967295;
        a.N[4] = a.N[4] + l & 4294967295;
      }
      La.prototype.update = function(a, b) {
        if (null != a) {
          n(b) || (b = a.length);
          for (var c = b - this.Va,
              d = 0,
              e = this.me,
              f = this.ac; d < b; ) {
            if (0 == f)
              for (; d <= c; )
                Ma(this, a, d), d += this.Va;
            if (p(a))
              for (; d < b; ) {
                if (e[f] = a.charCodeAt(d), ++f, ++d, f == this.Va) {
                  Ma(this, e);
                  f = 0;
                  break;
                }
              }
            else
              for (; d < b; )
                if (e[f] = a[d], ++f, ++d, f == this.Va) {
                  Ma(this, e);
                  f = 0;
                  break;
                }
          }
          this.ac = f;
          this.de += b;
        }
      };
      var u = Array.prototype,
          Na = u.indexOf ? function(a, b, c) {
            return u.indexOf.call(a, b, c);
          } : function(a, b, c) {
            c = null == c ? 0 : 0 > c ? Math.max(0, a.length + c) : c;
            if (p(a))
              return p(b) && 1 == b.length ? a.indexOf(b, c) : -1;
            for (; c < a.length; c++)
              if (c in a && a[c] === b)
                return c;
            return -1;
          },
          Oa = u.forEach ? function(a, b, c) {
            u.forEach.call(a, b, c);
          } : function(a, b, c) {
            for (var d = a.length,
                e = p(a) ? a.split("") : a,
                f = 0; f < d; f++)
              f in e && b.call(c, e[f], f, a);
          },
          Pa = u.filter ? function(a, b, c) {
            return u.filter.call(a, b, c);
          } : function(a, b, c) {
            for (var d = a.length,
                e = [],
                f = 0,
                h = p(a) ? a.split("") : a,
                k = 0; k < d; k++)
              if (k in h) {
                var l = h[k];
                b.call(c, l, k, a) && (e[f++] = l);
              }
            return e;
          },
          Qa = u.map ? function(a, b, c) {
            return u.map.call(a, b, c);
          } : function(a, b, c) {
            for (var d = a.length,
                e = Array(d),
                f = p(a) ? a.split("") : a,
                h = 0; h < d; h++)
              h in f && (e[h] = b.call(c, f[h], h, a));
            return e;
          },
          Ra = u.reduce ? function(a, b, c, d) {
            for (var e = [],
                f = 1,
                h = arguments.length; f < h; f++)
              e.push(arguments[f]);
            d && (e[0] = q(b, d));
            return u.reduce.apply(a, e);
          } : function(a, b, c, d) {
            var e = c;
            Oa(a, function(c, h) {
              e = b.call(d, e, c, h, a);
            });
            return e;
          },
          Sa = u.every ? function(a, b, c) {
            return u.every.call(a, b, c);
          } : function(a, b, c) {
            for (var d = a.length,
                e = p(a) ? a.split("") : a,
                f = 0; f < d; f++)
              if (f in e && !b.call(c, e[f], f, a))
                return !1;
            return !0;
          };
      function Ta(a, b) {
        var c = Ua(a, b, void 0);
        return 0 > c ? null : p(a) ? a.charAt(c) : a[c];
      }
      function Ua(a, b, c) {
        for (var d = a.length,
            e = p(a) ? a.split("") : a,
            f = 0; f < d; f++)
          if (f in e && b.call(c, e[f], f, a))
            return f;
        return -1;
      }
      function Va(a, b) {
        var c = Na(a, b);
        0 <= c && u.splice.call(a, c, 1);
      }
      function Wa(a, b, c) {
        return 2 >= arguments.length ? u.slice.call(a, b) : u.slice.call(a, b, c);
      }
      function Xa(a, b) {
        a.sort(b || Ya);
      }
      function Ya(a, b) {
        return a > b ? 1 : a < b ? -1 : 0;
      }
      ;
      var Za = -1 != Ha.indexOf("Opera") || -1 != Ha.indexOf("OPR"),
          $a = -1 != Ha.indexOf("Trident") || -1 != Ha.indexOf("MSIE"),
          ab = -1 != Ha.indexOf("Gecko") && -1 == Ha.toLowerCase().indexOf("webkit") && !(-1 != Ha.indexOf("Trident") || -1 != Ha.indexOf("MSIE")),
          bb = -1 != Ha.toLowerCase().indexOf("webkit");
      (function() {
        var a = "",
            b;
        if (Za && aa.opera)
          return a = aa.opera.version, ha(a) ? a() : a;
        ab ? b = /rv\:([^\);]+)(\)|;)/ : $a ? b = /\b(?:MSIE|rv)[: ]([^\);]+)(\)|;)/ : bb && (b = /WebKit\/(\S+)/);
        b && (a = (a = b.exec(Ha)) ? a[1] : "");
        return $a && (b = (b = aa.document) ? b.documentMode : void 0, b > parseFloat(a)) ? String(b) : a;
      })();
      var cb = null,
          db = null,
          eb = null;
      function fb(a, b) {
        if (!fa(a))
          throw Error("encodeByteArray takes an array as a parameter");
        gb();
        for (var c = b ? db : cb,
            d = [],
            e = 0; e < a.length; e += 3) {
          var f = a[e],
              h = e + 1 < a.length,
              k = h ? a[e + 1] : 0,
              l = e + 2 < a.length,
              m = l ? a[e + 2] : 0,
              t = f >> 2,
              f = (f & 3) << 4 | k >> 4,
              k = (k & 15) << 2 | m >> 6,
              m = m & 63;
          l || (m = 64, h || (k = 64));
          d.push(c[t], c[f], c[k], c[m]);
        }
        return d.join("");
      }
      function gb() {
        if (!cb) {
          cb = {};
          db = {};
          eb = {};
          for (var a = 0; 65 > a; a++)
            cb[a] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=".charAt(a), db[a] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.".charAt(a), eb[db[a]] = a, 62 <= a && (eb["ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=".charAt(a)] = a);
        }
      }
      ;
      var hb = hb || "2.3.2";
      function v(a, b) {
        return Object.prototype.hasOwnProperty.call(a, b);
      }
      function w(a, b) {
        if (Object.prototype.hasOwnProperty.call(a, b))
          return a[b];
      }
      function ib(a, b) {
        for (var c in a)
          Object.prototype.hasOwnProperty.call(a, c) && b(c, a[c]);
      }
      function jb(a) {
        var b = {};
        ib(a, function(a, d) {
          b[a] = d;
        });
        return b;
      }
      ;
      function kb(a) {
        var b = [];
        ib(a, function(a, d) {
          ea(d) ? Oa(d, function(d) {
            b.push(encodeURIComponent(a) + "=" + encodeURIComponent(d));
          }) : b.push(encodeURIComponent(a) + "=" + encodeURIComponent(d));
        });
        return b.length ? "&" + b.join("&") : "";
      }
      function lb(a) {
        var b = {};
        a = a.replace(/^\?/, "").split("&");
        Oa(a, function(a) {
          a && (a = a.split("="), b[a[0]] = a[1]);
        });
        return b;
      }
      ;
      function x(a, b, c, d) {
        var e;
        d < b ? e = "at least " + b : d > c && (e = 0 === c ? "none" : "no more than " + c);
        if (e)
          throw Error(a + " failed: Was called with " + d + (1 === d ? " argument." : " arguments.") + " Expects " + e + ".");
      }
      function y(a, b, c) {
        var d = "";
        switch (b) {
          case 1:
            d = c ? "first" : "First";
            break;
          case 2:
            d = c ? "second" : "Second";
            break;
          case 3:
            d = c ? "third" : "Third";
            break;
          case 4:
            d = c ? "fourth" : "Fourth";
            break;
          default:
            throw Error("errorPrefix called with argumentNumber > 4.  Need to update it?");
        }
        return a = a + " failed: " + (d + " argument ");
      }
      function A(a, b, c, d) {
        if ((!d || n(c)) && !ha(c))
          throw Error(y(a, b, d) + "must be a valid function.");
      }
      function mb(a, b, c) {
        if (n(c) && (!ia(c) || null === c))
          throw Error(y(a, b, !0) + "must be a valid context object.");
      }
      ;
      function nb(a) {
        return "undefined" !== typeof JSON && n(JSON.parse) ? JSON.parse(a) : Aa(a);
      }
      function B(a) {
        if ("undefined" !== typeof JSON && n(JSON.stringify))
          a = JSON.stringify(a);
        else {
          var b = [];
          Ca(new Ba, a, b);
          a = b.join("");
        }
        return a;
      }
      ;
      function ob() {
        this.Wd = C;
      }
      ob.prototype.j = function(a) {
        return this.Wd.Q(a);
      };
      ob.prototype.toString = function() {
        return this.Wd.toString();
      };
      function pb() {}
      pb.prototype.qf = function() {
        return null;
      };
      pb.prototype.ye = function() {
        return null;
      };
      var qb = new pb;
      function rb(a, b, c) {
        this.Tf = a;
        this.Ka = b;
        this.Kd = c;
      }
      rb.prototype.qf = function(a) {
        var b = this.Ka.O;
        if (sb(b, a))
          return b.j().R(a);
        b = null != this.Kd ? new tb(this.Kd, !0, !1) : this.Ka.w();
        return this.Tf.xc(a, b);
      };
      rb.prototype.ye = function(a, b, c) {
        var d = null != this.Kd ? this.Kd : ub(this.Ka);
        a = this.Tf.ne(d, b, 1, c, a);
        return 0 === a.length ? null : a[0];
      };
      function vb() {
        this.tb = [];
      }
      function wb(a, b) {
        for (var c = null,
            d = 0; d < b.length; d++) {
          var e = b[d],
              f = e.Zb();
          null === c || f.ca(c.Zb()) || (a.tb.push(c), c = null);
          null === c && (c = new xb(f));
          c.add(e);
        }
        c && a.tb.push(c);
      }
      function yb(a, b, c) {
        wb(a, c);
        zb(a, function(a) {
          return a.ca(b);
        });
      }
      function Ab(a, b, c) {
        wb(a, c);
        zb(a, function(a) {
          return a.contains(b) || b.contains(a);
        });
      }
      function zb(a, b) {
        for (var c = !0,
            d = 0; d < a.tb.length; d++) {
          var e = a.tb[d];
          if (e)
            if (e = e.Zb(), b(e)) {
              for (var e = a.tb[d],
                  f = 0; f < e.vd.length; f++) {
                var h = e.vd[f];
                if (null !== h) {
                  e.vd[f] = null;
                  var k = h.Vb();
                  Bb && Cb("event: " + h.toString());
                  Db(k);
                }
              }
              a.tb[d] = null;
            } else
              c = !1;
        }
        c && (a.tb = []);
      }
      function xb(a) {
        this.ra = a;
        this.vd = [];
      }
      xb.prototype.add = function(a) {
        this.vd.push(a);
      };
      xb.prototype.Zb = function() {
        return this.ra;
      };
      function D(a, b, c, d) {
        this.type = a;
        this.Ja = b;
        this.Wa = c;
        this.Ke = d;
        this.Qd = void 0;
      }
      function Eb(a) {
        return new D(Fb, a);
      }
      var Fb = "value";
      function Gb(a, b, c, d) {
        this.ue = b;
        this.Zd = c;
        this.Qd = d;
        this.ud = a;
      }
      Gb.prototype.Zb = function() {
        var a = this.Zd.Ib();
        return "value" === this.ud ? a.path : a.parent().path;
      };
      Gb.prototype.ze = function() {
        return this.ud;
      };
      Gb.prototype.Vb = function() {
        return this.ue.Vb(this);
      };
      Gb.prototype.toString = function() {
        return this.Zb().toString() + ":" + this.ud + ":" + B(this.Zd.mf());
      };
      function Hb(a, b, c) {
        this.ue = a;
        this.error = b;
        this.path = c;
      }
      Hb.prototype.Zb = function() {
        return this.path;
      };
      Hb.prototype.ze = function() {
        return "cancel";
      };
      Hb.prototype.Vb = function() {
        return this.ue.Vb(this);
      };
      Hb.prototype.toString = function() {
        return this.path.toString() + ":cancel";
      };
      function tb(a, b, c) {
        this.A = a;
        this.ea = b;
        this.Ub = c;
      }
      function Ib(a) {
        return a.ea;
      }
      function Jb(a) {
        return a.Ub;
      }
      function Kb(a, b) {
        return b.e() ? a.ea && !a.Ub : sb(a, E(b));
      }
      function sb(a, b) {
        return a.ea && !a.Ub || a.A.Da(b);
      }
      tb.prototype.j = function() {
        return this.A;
      };
      function Lb(a) {
        this.gg = a;
        this.Dd = null;
      }
      Lb.prototype.get = function() {
        var a = this.gg.get(),
            b = xa(a);
        if (this.Dd)
          for (var c in this.Dd)
            b[c] -= this.Dd[c];
        this.Dd = a;
        return b;
      };
      function Mb(a, b) {
        this.Of = {};
        this.fd = new Lb(a);
        this.ba = b;
        var c = 1E4 + 2E4 * Math.random();
        setTimeout(q(this.If, this), Math.floor(c));
      }
      Mb.prototype.If = function() {
        var a = this.fd.get(),
            b = {},
            c = !1,
            d;
        for (d in a)
          0 < a[d] && v(this.Of, d) && (b[d] = a[d], c = !0);
        c && this.ba.Ue(b);
        setTimeout(q(this.If, this), Math.floor(6E5 * Math.random()));
      };
      function Nb() {
        this.Ec = {};
      }
      function Ob(a, b, c) {
        n(c) || (c = 1);
        v(a.Ec, b) || (a.Ec[b] = 0);
        a.Ec[b] += c;
      }
      Nb.prototype.get = function() {
        return xa(this.Ec);
      };
      var Pb = {},
          Qb = {};
      function Rb(a) {
        a = a.toString();
        Pb[a] || (Pb[a] = new Nb);
        return Pb[a];
      }
      function Sb(a, b) {
        var c = a.toString();
        Qb[c] || (Qb[c] = b());
        return Qb[c];
      }
      ;
      function F(a, b) {
        this.name = a;
        this.S = b;
      }
      function Tb(a, b) {
        return new F(a, b);
      }
      ;
      function Ub(a, b) {
        return Vb(a.name, b.name);
      }
      function Wb(a, b) {
        return Vb(a, b);
      }
      ;
      function Xb(a, b, c) {
        this.type = Yb;
        this.source = a;
        this.path = b;
        this.Ga = c;
      }
      Xb.prototype.Xc = function(a) {
        return this.path.e() ? new Xb(this.source, G, this.Ga.R(a)) : new Xb(this.source, H(this.path), this.Ga);
      };
      Xb.prototype.toString = function() {
        return "Operation(" + this.path + ": " + this.source.toString() + " overwrite: " + this.Ga.toString() + ")";
      };
      function Zb(a, b) {
        this.type = $b;
        this.source = a;
        this.path = b;
      }
      Zb.prototype.Xc = function() {
        return this.path.e() ? new Zb(this.source, G) : new Zb(this.source, H(this.path));
      };
      Zb.prototype.toString = function() {
        return "Operation(" + this.path + ": " + this.source.toString() + " listen_complete)";
      };
      function ac(a, b) {
        this.La = a;
        this.wa = b ? b : bc;
      }
      g = ac.prototype;
      g.Oa = function(a, b) {
        return new ac(this.La, this.wa.Oa(a, b, this.La).Y(null, null, !1, null, null));
      };
      g.remove = function(a) {
        return new ac(this.La, this.wa.remove(a, this.La).Y(null, null, !1, null, null));
      };
      g.get = function(a) {
        for (var b,
            c = this.wa; !c.e(); ) {
          b = this.La(a, c.key);
          if (0 === b)
            return c.value;
          0 > b ? c = c.left : 0 < b && (c = c.right);
        }
        return null;
      };
      function cc(a, b) {
        for (var c,
            d = a.wa,
            e = null; !d.e(); ) {
          c = a.La(b, d.key);
          if (0 === c) {
            if (d.left.e())
              return e ? e.key : null;
            for (d = d.left; !d.right.e(); )
              d = d.right;
            return d.key;
          }
          0 > c ? d = d.left : 0 < c && (e = d, d = d.right);
        }
        throw Error("Attempted to find predecessor key for a nonexistent key.  What gives?");
      }
      g.e = function() {
        return this.wa.e();
      };
      g.count = function() {
        return this.wa.count();
      };
      g.Sc = function() {
        return this.wa.Sc();
      };
      g.fc = function() {
        return this.wa.fc();
      };
      g.ia = function(a) {
        return this.wa.ia(a);
      };
      g.Xb = function(a) {
        return new dc(this.wa, null, this.La, !1, a);
      };
      g.Yb = function(a, b) {
        return new dc(this.wa, a, this.La, !1, b);
      };
      g.$b = function(a, b) {
        return new dc(this.wa, a, this.La, !0, b);
      };
      g.sf = function(a) {
        return new dc(this.wa, null, this.La, !0, a);
      };
      function dc(a, b, c, d, e) {
        this.Ud = e || null;
        this.Fe = d;
        this.Pa = [];
        for (e = 1; !a.e(); )
          if (e = b ? c(a.key, b) : 1, d && (e *= -1), 0 > e)
            a = this.Fe ? a.left : a.right;
          else if (0 === e) {
            this.Pa.push(a);
            break;
          } else
            this.Pa.push(a), a = this.Fe ? a.right : a.left;
      }
      function J(a) {
        if (0 === a.Pa.length)
          return null;
        var b = a.Pa.pop(),
            c;
        c = a.Ud ? a.Ud(b.key, b.value) : {
          key: b.key,
          value: b.value
        };
        if (a.Fe)
          for (b = b.left; !b.e(); )
            a.Pa.push(b), b = b.right;
        else
          for (b = b.right; !b.e(); )
            a.Pa.push(b), b = b.left;
        return c;
      }
      function ec(a) {
        if (0 === a.Pa.length)
          return null;
        var b;
        b = a.Pa;
        b = b[b.length - 1];
        return a.Ud ? a.Ud(b.key, b.value) : {
          key: b.key,
          value: b.value
        };
      }
      function fc(a, b, c, d, e) {
        this.key = a;
        this.value = b;
        this.color = null != c ? c : !0;
        this.left = null != d ? d : bc;
        this.right = null != e ? e : bc;
      }
      g = fc.prototype;
      g.Y = function(a, b, c, d, e) {
        return new fc(null != a ? a : this.key, null != b ? b : this.value, null != c ? c : this.color, null != d ? d : this.left, null != e ? e : this.right);
      };
      g.count = function() {
        return this.left.count() + 1 + this.right.count();
      };
      g.e = function() {
        return !1;
      };
      g.ia = function(a) {
        return this.left.ia(a) || a(this.key, this.value) || this.right.ia(a);
      };
      function gc(a) {
        return a.left.e() ? a : gc(a.left);
      }
      g.Sc = function() {
        return gc(this).key;
      };
      g.fc = function() {
        return this.right.e() ? this.key : this.right.fc();
      };
      g.Oa = function(a, b, c) {
        var d,
            e;
        e = this;
        d = c(a, e.key);
        e = 0 > d ? e.Y(null, null, null, e.left.Oa(a, b, c), null) : 0 === d ? e.Y(null, b, null, null, null) : e.Y(null, null, null, null, e.right.Oa(a, b, c));
        return hc(e);
      };
      function ic(a) {
        if (a.left.e())
          return bc;
        a.left.fa() || a.left.left.fa() || (a = jc(a));
        a = a.Y(null, null, null, ic(a.left), null);
        return hc(a);
      }
      g.remove = function(a, b) {
        var c,
            d;
        c = this;
        if (0 > b(a, c.key))
          c.left.e() || c.left.fa() || c.left.left.fa() || (c = jc(c)), c = c.Y(null, null, null, c.left.remove(a, b), null);
        else {
          c.left.fa() && (c = kc(c));
          c.right.e() || c.right.fa() || c.right.left.fa() || (c = lc(c), c.left.left.fa() && (c = kc(c), c = lc(c)));
          if (0 === b(a, c.key)) {
            if (c.right.e())
              return bc;
            d = gc(c.right);
            c = c.Y(d.key, d.value, null, null, ic(c.right));
          }
          c = c.Y(null, null, null, null, c.right.remove(a, b));
        }
        return hc(c);
      };
      g.fa = function() {
        return this.color;
      };
      function hc(a) {
        a.right.fa() && !a.left.fa() && (a = mc(a));
        a.left.fa() && a.left.left.fa() && (a = kc(a));
        a.left.fa() && a.right.fa() && (a = lc(a));
        return a;
      }
      function jc(a) {
        a = lc(a);
        a.right.left.fa() && (a = a.Y(null, null, null, null, kc(a.right)), a = mc(a), a = lc(a));
        return a;
      }
      function mc(a) {
        return a.right.Y(null, null, a.color, a.Y(null, null, !0, null, a.right.left), null);
      }
      function kc(a) {
        return a.left.Y(null, null, a.color, null, a.Y(null, null, !0, a.left.right, null));
      }
      function lc(a) {
        return a.Y(null, null, !a.color, a.left.Y(null, null, !a.left.color, null, null), a.right.Y(null, null, !a.right.color, null, null));
      }
      function nc() {}
      g = nc.prototype;
      g.Y = function() {
        return this;
      };
      g.Oa = function(a, b) {
        return new fc(a, b, null);
      };
      g.remove = function() {
        return this;
      };
      g.count = function() {
        return 0;
      };
      g.e = function() {
        return !0;
      };
      g.ia = function() {
        return !1;
      };
      g.Sc = function() {
        return null;
      };
      g.fc = function() {
        return null;
      };
      g.fa = function() {
        return !1;
      };
      var bc = new nc;
      function oc(a, b) {
        return a && "object" === typeof a ? (K(".sv" in a, "Unexpected leaf node or priority contents"), b[a[".sv"]]) : a;
      }
      function pc(a, b) {
        var c = new qc;
        rc(a, new L(""), function(a, e) {
          c.nc(a, sc(e, b));
        });
        return c;
      }
      function sc(a, b) {
        var c = a.C().I(),
            c = oc(c, b),
            d;
        if (a.K()) {
          var e = oc(a.Ca(), b);
          return e !== a.Ca() || c !== a.C().I() ? new tc(e, M(c)) : a;
        }
        d = a;
        c !== a.C().I() && (d = d.ga(new tc(c)));
        a.P(N, function(a, c) {
          var e = sc(c, b);
          e !== c && (d = d.U(a, e));
        });
        return d;
      }
      ;
      function uc() {
        this.wc = {};
      }
      uc.prototype.set = function(a, b) {
        null == b ? delete this.wc[a] : this.wc[a] = b;
      };
      uc.prototype.get = function(a) {
        return v(this.wc, a) ? this.wc[a] : null;
      };
      uc.prototype.remove = function(a) {
        delete this.wc[a];
      };
      uc.prototype.wf = !0;
      function vc(a) {
        this.Fc = a;
        this.Pd = "firebase:";
      }
      g = vc.prototype;
      g.set = function(a, b) {
        null == b ? this.Fc.removeItem(this.Pd + a) : this.Fc.setItem(this.Pd + a, B(b));
      };
      g.get = function(a) {
        a = this.Fc.getItem(this.Pd + a);
        return null == a ? null : nb(a);
      };
      g.remove = function(a) {
        this.Fc.removeItem(this.Pd + a);
      };
      g.wf = !1;
      g.toString = function() {
        return this.Fc.toString();
      };
      function wc(a) {
        try {
          if ("undefined" !== typeof window && "undefined" !== typeof window[a]) {
            var b = window[a];
            b.setItem("firebase:sentinel", "cache");
            b.removeItem("firebase:sentinel");
            return new vc(b);
          }
        } catch (c) {}
        return new uc;
      }
      var xc = wc("localStorage"),
          yc = wc("sessionStorage");
      function zc(a, b, c, d, e) {
        this.host = a.toLowerCase();
        this.domain = this.host.substr(this.host.indexOf(".") + 1);
        this.kb = b;
        this.hc = c;
        this.Wg = d;
        this.Od = e || "";
        this.Ya = xc.get("host:" + a) || this.host;
      }
      function Ac(a, b) {
        b !== a.Ya && (a.Ya = b, "s-" === a.Ya.substr(0, 2) && xc.set("host:" + a.host, a.Ya));
      }
      function Bc(a, b, c) {
        K("string" === typeof b, "typeof type must == string");
        K("object" === typeof c, "typeof params must == object");
        if (b === Cc)
          b = (a.kb ? "wss://" : "ws://") + a.Ya + "/.ws?";
        else if (b === Dc)
          b = (a.kb ? "https://" : "http://") + a.Ya + "/.lp?";
        else
          throw Error("Unknown connection type: " + b);
        a.host !== a.Ya && (c.ns = a.hc);
        var d = [];
        r(c, function(a, b) {
          d.push(b + "=" + a);
        });
        return b + d.join("&");
      }
      zc.prototype.toString = function() {
        var a = (this.kb ? "https://" : "http://") + this.host;
        this.Od && (a += "<" + this.Od + ">");
        return a;
      };
      var Ec = function() {
        var a = 1;
        return function() {
          return a++;
        };
      }();
      function K(a, b) {
        if (!a)
          throw Fc(b);
      }
      function Fc(a) {
        return Error("Firebase (" + hb + ") INTERNAL ASSERT FAILED: " + a);
      }
      function Gc(a) {
        try {
          var b;
          if ("undefined" !== typeof atob)
            b = atob(a);
          else {
            gb();
            for (var c = eb,
                d = [],
                e = 0; e < a.length; ) {
              var f = c[a.charAt(e++)],
                  h = e < a.length ? c[a.charAt(e)] : 0;
              ++e;
              var k = e < a.length ? c[a.charAt(e)] : 64;
              ++e;
              var l = e < a.length ? c[a.charAt(e)] : 64;
              ++e;
              if (null == f || null == h || null == k || null == l)
                throw Error();
              d.push(f << 2 | h >> 4);
              64 != k && (d.push(h << 4 & 240 | k >> 2), 64 != l && d.push(k << 6 & 192 | l));
            }
            if (8192 > d.length)
              b = String.fromCharCode.apply(null, d);
            else {
              a = "";
              for (c = 0; c < d.length; c += 8192)
                a += String.fromCharCode.apply(null, Wa(d, c, c + 8192));
              b = a;
            }
          }
          return b;
        } catch (m) {
          Cb("base64Decode failed: ", m);
        }
        return null;
      }
      function Hc(a) {
        var b = Ic(a);
        a = new La;
        a.update(b);
        var b = [],
            c = 8 * a.de;
        56 > a.ac ? a.update(a.Ld, 56 - a.ac) : a.update(a.Ld, a.Va - (a.ac - 56));
        for (var d = a.Va - 1; 56 <= d; d--)
          a.me[d] = c & 255, c /= 256;
        Ma(a, a.me);
        for (d = c = 0; 5 > d; d++)
          for (var e = 24; 0 <= e; e -= 8)
            b[c] = a.N[d] >> e & 255, ++c;
        return fb(b);
      }
      function Jc(a) {
        for (var b = "",
            c = 0; c < arguments.length; c++)
          b = fa(arguments[c]) ? b + Jc.apply(null, arguments[c]) : "object" === typeof arguments[c] ? b + B(arguments[c]) : b + arguments[c], b += " ";
        return b;
      }
      var Bb = null,
          Kc = !0;
      function Cb(a) {
        !0 === Kc && (Kc = !1, null === Bb && !0 === yc.get("logging_enabled") && Lc(!0));
        if (Bb) {
          var b = Jc.apply(null, arguments);
          Bb(b);
        }
      }
      function Mc(a) {
        return function() {
          Cb(a, arguments);
        };
      }
      function Nc(a) {
        if ("undefined" !== typeof console) {
          var b = "FIREBASE INTERNAL ERROR: " + Jc.apply(null, arguments);
          "undefined" !== typeof console.error ? console.error(b) : console.log(b);
        }
      }
      function Oc(a) {
        var b = Jc.apply(null, arguments);
        throw Error("FIREBASE FATAL ERROR: " + b);
      }
      function O(a) {
        if ("undefined" !== typeof console) {
          var b = "FIREBASE WARNING: " + Jc.apply(null, arguments);
          "undefined" !== typeof console.warn ? console.warn(b) : console.log(b);
        }
      }
      function Pc(a) {
        var b = "",
            c = "",
            d = "",
            e = "",
            f = !0,
            h = "https",
            k = 443;
        if (p(a)) {
          var l = a.indexOf("//");
          0 <= l && (h = a.substring(0, l - 1), a = a.substring(l + 2));
          l = a.indexOf("/");
          -1 === l && (l = a.length);
          b = a.substring(0, l);
          e = "";
          a = a.substring(l).split("/");
          for (l = 0; l < a.length; l++)
            if (0 < a[l].length) {
              var m = a[l];
              try {
                m = decodeURIComponent(m.replace(/\+/g, " "));
              } catch (t) {}
              e += "/" + m;
            }
          a = b.split(".");
          3 === a.length ? (c = a[1], d = a[0].toLowerCase()) : 2 === a.length && (c = a[0]);
          l = b.indexOf(":");
          0 <= l && (f = "https" === h || "wss" === h, k = b.substring(l + 1), isFinite(k) && (k = String(k)), k = p(k) ? /^\s*-?0x/i.test(k) ? parseInt(k, 16) : parseInt(k, 10) : NaN);
        }
        return {
          host: b,
          port: k,
          domain: c,
          Tg: d,
          kb: f,
          scheme: h,
          $c: e
        };
      }
      function Qc(a) {
        return ga(a) && (a != a || a == Number.POSITIVE_INFINITY || a == Number.NEGATIVE_INFINITY);
      }
      function Rc(a) {
        if ("complete" === document.readyState)
          a();
        else {
          var b = !1,
              c = function() {
                document.body ? b || (b = !0, a()) : setTimeout(c, Math.floor(10));
              };
          document.addEventListener ? (document.addEventListener("DOMContentLoaded", c, !1), window.addEventListener("load", c, !1)) : document.attachEvent && (document.attachEvent("onreadystatechange", function() {
            "complete" === document.readyState && c();
          }), window.attachEvent("onload", c));
        }
      }
      function Vb(a, b) {
        if (a === b)
          return 0;
        if ("[MIN_NAME]" === a || "[MAX_NAME]" === b)
          return -1;
        if ("[MIN_NAME]" === b || "[MAX_NAME]" === a)
          return 1;
        var c = Sc(a),
            d = Sc(b);
        return null !== c ? null !== d ? 0 == c - d ? a.length - b.length : c - d : -1 : null !== d ? 1 : a < b ? -1 : 1;
      }
      function Tc(a, b) {
        if (b && a in b)
          return b[a];
        throw Error("Missing required key (" + a + ") in object: " + B(b));
      }
      function Uc(a) {
        if ("object" !== typeof a || null === a)
          return B(a);
        var b = [],
            c;
        for (c in a)
          b.push(c);
        b.sort();
        c = "{";
        for (var d = 0; d < b.length; d++)
          0 !== d && (c += ","), c += B(b[d]), c += ":", c += Uc(a[b[d]]);
        return c + "}";
      }
      function Vc(a, b) {
        if (a.length <= b)
          return [a];
        for (var c = [],
            d = 0; d < a.length; d += b)
          d + b > a ? c.push(a.substring(d, a.length)) : c.push(a.substring(d, d + b));
        return c;
      }
      function Wc(a, b) {
        if (ea(a))
          for (var c = 0; c < a.length; ++c)
            b(c, a[c]);
        else
          r(a, b);
      }
      function Xc(a) {
        K(!Qc(a), "Invalid JSON number");
        var b,
            c,
            d,
            e;
        0 === a ? (d = c = 0, b = -Infinity === 1 / a ? 1 : 0) : (b = 0 > a, a = Math.abs(a), a >= Math.pow(2, -1022) ? (d = Math.min(Math.floor(Math.log(a) / Math.LN2), 1023), c = d + 1023, d = Math.round(a * Math.pow(2, 52 - d) - Math.pow(2, 52))) : (c = 0, d = Math.round(a / Math.pow(2, -1074))));
        e = [];
        for (a = 52; a; --a)
          e.push(d % 2 ? 1 : 0), d = Math.floor(d / 2);
        for (a = 11; a; --a)
          e.push(c % 2 ? 1 : 0), c = Math.floor(c / 2);
        e.push(b ? 1 : 0);
        e.reverse();
        b = e.join("");
        c = "";
        for (a = 0; 64 > a; a += 8)
          d = parseInt(b.substr(a, 8), 2).toString(16), 1 === d.length && (d = "0" + d), c += d;
        return c.toLowerCase();
      }
      var Yc = /^-?\d{1,10}$/;
      function Sc(a) {
        return Yc.test(a) && (a = Number(a), -2147483648 <= a && 2147483647 >= a) ? a : null;
      }
      function Db(a) {
        try {
          a();
        } catch (b) {
          setTimeout(function() {
            O("Exception was thrown by user callback.", b.stack || "");
            throw b;
          }, Math.floor(0));
        }
      }
      function P(a, b) {
        if (ha(a)) {
          var c = Array.prototype.slice.call(arguments, 1).slice();
          Db(function() {
            a.apply(null, c);
          });
        }
      }
      ;
      function Ic(a) {
        for (var b = [],
            c = 0,
            d = 0; d < a.length; d++) {
          var e = a.charCodeAt(d);
          55296 <= e && 56319 >= e && (e -= 55296, d++, K(d < a.length, "Surrogate pair missing trail surrogate."), e = 65536 + (e << 10) + (a.charCodeAt(d) - 56320));
          128 > e ? b[c++] = e : (2048 > e ? b[c++] = e >> 6 | 192 : (65536 > e ? b[c++] = e >> 12 | 224 : (b[c++] = e >> 18 | 240, b[c++] = e >> 12 & 63 | 128), b[c++] = e >> 6 & 63 | 128), b[c++] = e & 63 | 128);
        }
        return b;
      }
      function Zc(a) {
        for (var b = 0,
            c = 0; c < a.length; c++) {
          var d = a.charCodeAt(c);
          128 > d ? b++ : 2048 > d ? b += 2 : 55296 <= d && 56319 >= d ? (b += 4, c++) : b += 3;
        }
        return b;
      }
      ;
      function $c(a) {
        var b = {},
            c = {},
            d = {},
            e = "";
        try {
          var f = a.split("."),
              b = nb(Gc(f[0]) || ""),
              c = nb(Gc(f[1]) || ""),
              e = f[2],
              d = c.d || {};
          delete c.d;
        } catch (h) {}
        return {
          Zg: b,
          Bc: c,
          data: d,
          Qg: e
        };
      }
      function ad(a) {
        a = $c(a).Bc;
        return "object" === typeof a && a.hasOwnProperty("iat") ? w(a, "iat") : null;
      }
      function bd(a) {
        a = $c(a);
        var b = a.Bc;
        return !!a.Qg && !!b && "object" === typeof b && b.hasOwnProperty("iat");
      }
      ;
      function cd(a) {
        this.W = a;
        this.g = a.n.g;
      }
      function dd(a, b, c, d) {
        var e = [],
            f = [];
        Oa(b, function(b) {
          "child_changed" === b.type && a.g.Ad(b.Ke, b.Ja) && f.push(new D("child_moved", b.Ja, b.Wa));
        });
        ed(a, e, "child_removed", b, d, c);
        ed(a, e, "child_added", b, d, c);
        ed(a, e, "child_moved", f, d, c);
        ed(a, e, "child_changed", b, d, c);
        ed(a, e, Fb, b, d, c);
        return e;
      }
      function ed(a, b, c, d, e, f) {
        d = Pa(d, function(a) {
          return a.type === c;
        });
        Xa(d, q(a.hg, a));
        Oa(d, function(c) {
          var d = fd(a, c, f);
          Oa(e, function(e) {
            e.Kf(c.type) && b.push(e.createEvent(d, a.W));
          });
        });
      }
      function fd(a, b, c) {
        "value" !== b.type && "child_removed" !== b.type && (b.Qd = c.rf(b.Wa, b.Ja, a.g));
        return b;
      }
      cd.prototype.hg = function(a, b) {
        if (null == a.Wa || null == b.Wa)
          throw Fc("Should only compare child_ events.");
        return this.g.compare(new F(a.Wa, a.Ja), new F(b.Wa, b.Ja));
      };
      function gd() {
        this.bb = {};
      }
      function hd(a, b) {
        var c = b.type,
            d = b.Wa;
        K("child_added" == c || "child_changed" == c || "child_removed" == c, "Only child changes supported for tracking");
        K(".priority" !== d, "Only non-priority child changes can be tracked.");
        var e = w(a.bb, d);
        if (e) {
          var f = e.type;
          if ("child_added" == c && "child_removed" == f)
            a.bb[d] = new D("child_changed", b.Ja, d, e.Ja);
          else if ("child_removed" == c && "child_added" == f)
            delete a.bb[d];
          else if ("child_removed" == c && "child_changed" == f)
            a.bb[d] = new D("child_removed", e.Ke, d);
          else if ("child_changed" == c && "child_added" == f)
            a.bb[d] = new D("child_added", b.Ja, d);
          else if ("child_changed" == c && "child_changed" == f)
            a.bb[d] = new D("child_changed", b.Ja, d, e.Ke);
          else
            throw Fc("Illegal combination of changes: " + b + " occurred after " + e);
        } else
          a.bb[d] = b;
      }
      ;
      function id(a, b, c) {
        this.Rb = a;
        this.pb = b;
        this.rb = c || null;
      }
      g = id.prototype;
      g.Kf = function(a) {
        return "value" === a;
      };
      g.createEvent = function(a, b) {
        var c = b.n.g;
        return new Gb("value", this, new Q(a.Ja, b.Ib(), c));
      };
      g.Vb = function(a) {
        var b = this.rb;
        if ("cancel" === a.ze()) {
          K(this.pb, "Raising a cancel event on a listener with no cancel callback");
          var c = this.pb;
          return function() {
            c.call(b, a.error);
          };
        }
        var d = this.Rb;
        return function() {
          d.call(b, a.Zd);
        };
      };
      g.gf = function(a, b) {
        return this.pb ? new Hb(this, a, b) : null;
      };
      g.matches = function(a) {
        return a instanceof id ? a.Rb && this.Rb ? a.Rb === this.Rb && a.rb === this.rb : !0 : !1;
      };
      g.tf = function() {
        return null !== this.Rb;
      };
      function jd(a, b, c) {
        this.ha = a;
        this.pb = b;
        this.rb = c;
      }
      g = jd.prototype;
      g.Kf = function(a) {
        a = "children_added" === a ? "child_added" : a;
        return ("children_removed" === a ? "child_removed" : a) in this.ha;
      };
      g.gf = function(a, b) {
        return this.pb ? new Hb(this, a, b) : null;
      };
      g.createEvent = function(a, b) {
        K(null != a.Wa, "Child events should have a childName.");
        var c = b.Ib().u(a.Wa);
        return new Gb(a.type, this, new Q(a.Ja, c, b.n.g), a.Qd);
      };
      g.Vb = function(a) {
        var b = this.rb;
        if ("cancel" === a.ze()) {
          K(this.pb, "Raising a cancel event on a listener with no cancel callback");
          var c = this.pb;
          return function() {
            c.call(b, a.error);
          };
        }
        var d = this.ha[a.ud];
        return function() {
          d.call(b, a.Zd, a.Qd);
        };
      };
      g.matches = function(a) {
        if (a instanceof jd) {
          if (!this.ha || !a.ha)
            return !0;
          if (this.rb === a.rb) {
            var b = pa(a.ha);
            if (b === pa(this.ha)) {
              if (1 === b) {
                var b = qa(a.ha),
                    c = qa(this.ha);
                return c === b && (!a.ha[b] || !this.ha[c] || a.ha[b] === this.ha[c]);
              }
              return oa(this.ha, function(b, c) {
                return a.ha[c] === b;
              });
            }
          }
        }
        return !1;
      };
      g.tf = function() {
        return null !== this.ha;
      };
      function kd(a) {
        this.g = a;
      }
      g = kd.prototype;
      g.G = function(a, b, c, d, e, f) {
        K(a.Jc(this.g), "A node must be indexed if only a child is updated");
        e = a.R(b);
        if (e.Q(d).ca(c.Q(d)) && e.e() == c.e())
          return a;
        null != f && (c.e() ? a.Da(b) ? hd(f, new D("child_removed", e, b)) : K(a.K(), "A child remove without an old child only makes sense on a leaf node") : e.e() ? hd(f, new D("child_added", c, b)) : hd(f, new D("child_changed", c, b, e)));
        return a.K() && c.e() ? a : a.U(b, c).lb(this.g);
      };
      g.xa = function(a, b, c) {
        null != c && (a.K() || a.P(N, function(a, e) {
          b.Da(a) || hd(c, new D("child_removed", e, a));
        }), b.K() || b.P(N, function(b, e) {
          if (a.Da(b)) {
            var f = a.R(b);
            f.ca(e) || hd(c, new D("child_changed", e, b, f));
          } else
            hd(c, new D("child_added", e, b));
        }));
        return b.lb(this.g);
      };
      g.ga = function(a, b) {
        return a.e() ? C : a.ga(b);
      };
      g.Na = function() {
        return !1;
      };
      g.Wb = function() {
        return this;
      };
      function ld(a) {
        this.Be = new kd(a.g);
        this.g = a.g;
        var b;
        a.ma ? (b = md(a), b = a.g.Pc(nd(a), b)) : b = a.g.Tc();
        this.ed = b;
        a.pa ? (b = od(a), a = a.g.Pc(pd(a), b)) : a = a.g.Qc();
        this.Gc = a;
      }
      g = ld.prototype;
      g.matches = function(a) {
        return 0 >= this.g.compare(this.ed, a) && 0 >= this.g.compare(a, this.Gc);
      };
      g.G = function(a, b, c, d, e, f) {
        this.matches(new F(b, c)) || (c = C);
        return this.Be.G(a, b, c, d, e, f);
      };
      g.xa = function(a, b, c) {
        b.K() && (b = C);
        var d = b.lb(this.g),
            d = d.ga(C),
            e = this;
        b.P(N, function(a, b) {
          e.matches(new F(a, b)) || (d = d.U(a, C));
        });
        return this.Be.xa(a, d, c);
      };
      g.ga = function(a) {
        return a;
      };
      g.Na = function() {
        return !0;
      };
      g.Wb = function() {
        return this.Be;
      };
      function qd(a) {
        this.sa = new ld(a);
        this.g = a.g;
        K(a.ja, "Only valid if limit has been set");
        this.ka = a.ka;
        this.Jb = !rd(a);
      }
      g = qd.prototype;
      g.G = function(a, b, c, d, e, f) {
        this.sa.matches(new F(b, c)) || (c = C);
        return a.R(b).ca(c) ? a : a.Db() < this.ka ? this.sa.Wb().G(a, b, c, d, e, f) : sd(this, a, b, c, e, f);
      };
      g.xa = function(a, b, c) {
        var d;
        if (b.K() || b.e())
          d = C.lb(this.g);
        else if (2 * this.ka < b.Db() && b.Jc(this.g)) {
          d = C.lb(this.g);
          b = this.Jb ? b.$b(this.sa.Gc, this.g) : b.Yb(this.sa.ed, this.g);
          for (var e = 0; 0 < b.Pa.length && e < this.ka; ) {
            var f = J(b),
                h;
            if (h = this.Jb ? 0 >= this.g.compare(this.sa.ed, f) : 0 >= this.g.compare(f, this.sa.Gc))
              d = d.U(f.name, f.S), e++;
            else
              break;
          }
        } else {
          d = b.lb(this.g);
          d = d.ga(C);
          var k,
              l,
              m;
          if (this.Jb) {
            b = d.sf(this.g);
            k = this.sa.Gc;
            l = this.sa.ed;
            var t = td(this.g);
            m = function(a, b) {
              return t(b, a);
            };
          } else
            b = d.Xb(this.g), k = this.sa.ed, l = this.sa.Gc, m = td(this.g);
          for (var e = 0,
              z = !1; 0 < b.Pa.length; )
            f = J(b), !z && 0 >= m(k, f) && (z = !0), (h = z && e < this.ka && 0 >= m(f, l)) ? e++ : d = d.U(f.name, C);
        }
        return this.sa.Wb().xa(a, d, c);
      };
      g.ga = function(a) {
        return a;
      };
      g.Na = function() {
        return !0;
      };
      g.Wb = function() {
        return this.sa.Wb();
      };
      function sd(a, b, c, d, e, f) {
        var h;
        if (a.Jb) {
          var k = td(a.g);
          h = function(a, b) {
            return k(b, a);
          };
        } else
          h = td(a.g);
        K(b.Db() == a.ka, "");
        var l = new F(c, d),
            m = a.Jb ? ud(b, a.g) : vd(b, a.g),
            t = a.sa.matches(l);
        if (b.Da(c)) {
          for (var z = b.R(c),
              m = e.ye(a.g, m, a.Jb); null != m && (m.name == c || b.Da(m.name)); )
            m = e.ye(a.g, m, a.Jb);
          e = null == m ? 1 : h(m, l);
          if (t && !d.e() && 0 <= e)
            return null != f && hd(f, new D("child_changed", d, c, z)), b.U(c, d);
          null != f && hd(f, new D("child_removed", z, c));
          b = b.U(c, C);
          return null != m && a.sa.matches(m) ? (null != f && hd(f, new D("child_added", m.S, m.name)), b.U(m.name, m.S)) : b;
        }
        return d.e() ? b : t && 0 <= h(m, l) ? (null != f && (hd(f, new D("child_removed", m.S, m.name)), hd(f, new D("child_added", d, c))), b.U(c, d).U(m.name, C)) : b;
      }
      ;
      function wd(a, b) {
        this.je = a;
        this.fg = b;
      }
      function xd(a) {
        this.V = a;
      }
      xd.prototype.ab = function(a, b, c, d) {
        var e = new gd,
            f;
        if (b.type === Yb)
          b.source.we ? c = yd(this, a, b.path, b.Ga, c, d, e) : (K(b.source.pf, "Unknown source."), f = b.source.af || Jb(a.w()) && !b.path.e(), c = Ad(this, a, b.path, b.Ga, c, d, f, e));
        else if (b.type === Bd)
          b.source.we ? c = Cd(this, a, b.path, b.children, c, d, e) : (K(b.source.pf, "Unknown source."), f = b.source.af || Jb(a.w()), c = Dd(this, a, b.path, b.children, c, d, f, e));
        else if (b.type === Ed)
          if (b.Vd)
            if (b = b.path, null != c.tc(b))
              c = a;
            else {
              f = new rb(c, a, d);
              d = a.O.j();
              if (b.e() || ".priority" === E(b))
                Ib(a.w()) ? b = c.za(ub(a)) : (b = a.w().j(), K(b instanceof R, "serverChildren would be complete if leaf node"), b = c.yc(b)), b = this.V.xa(d, b, e);
              else {
                var h = E(b),
                    k = c.xc(h, a.w());
                null == k && sb(a.w(), h) && (k = d.R(h));
                b = null != k ? this.V.G(d, h, k, H(b), f, e) : a.O.j().Da(h) ? this.V.G(d, h, C, H(b), f, e) : d;
                b.e() && Ib(a.w()) && (d = c.za(ub(a)), d.K() && (b = this.V.xa(b, d, e)));
              }
              d = Ib(a.w()) || null != c.tc(G);
              c = Fd(a, b, d, this.V.Na());
            }
          else
            c = Gd(this, a, b.path, b.Qb, c, d, e);
        else if (b.type === $b)
          d = b.path, b = a.w(), f = b.j(), h = b.ea || d.e(), c = Hd(this, new Id(a.O, new tb(f, h, b.Ub)), d, c, qb, e);
        else
          throw Fc("Unknown operation type: " + b.type);
        e = ra(e.bb);
        d = c;
        b = d.O;
        b.ea && (f = b.j().K() || b.j().e(), h = Jd(a), (0 < e.length || !a.O.ea || f && !b.j().ca(h) || !b.j().C().ca(h.C())) && e.push(Eb(Jd(d))));
        return new wd(c, e);
      };
      function Hd(a, b, c, d, e, f) {
        var h = b.O;
        if (null != d.tc(c))
          return b;
        var k;
        if (c.e())
          K(Ib(b.w()), "If change path is empty, we must have complete server data"), Jb(b.w()) ? (e = ub(b), d = d.yc(e instanceof R ? e : C)) : d = d.za(ub(b)), f = a.V.xa(b.O.j(), d, f);
        else {
          var l = E(c);
          if (".priority" == l)
            K(1 == Kd(c), "Can't have a priority with additional path components"), f = h.j(), k = b.w().j(), d = d.ld(c, f, k), f = null != d ? a.V.ga(f, d) : h.j();
          else {
            var m = H(c);
            sb(h, l) ? (k = b.w().j(), d = d.ld(c, h.j(), k), d = null != d ? h.j().R(l).G(m, d) : h.j().R(l)) : d = d.xc(l, b.w());
            f = null != d ? a.V.G(h.j(), l, d, m, e, f) : h.j();
          }
        }
        return Fd(b, f, h.ea || c.e(), a.V.Na());
      }
      function Ad(a, b, c, d, e, f, h, k) {
        var l = b.w();
        h = h ? a.V : a.V.Wb();
        if (c.e())
          d = h.xa(l.j(), d, null);
        else if (h.Na() && !l.Ub)
          d = l.j().G(c, d), d = h.xa(l.j(), d, null);
        else {
          var m = E(c);
          if (!Kb(l, c) && 1 < Kd(c))
            return b;
          var t = H(c);
          d = l.j().R(m).G(t, d);
          d = ".priority" == m ? h.ga(l.j(), d) : h.G(l.j(), m, d, t, qb, null);
        }
        l = l.ea || c.e();
        b = new Id(b.O, new tb(d, l, h.Na()));
        return Hd(a, b, c, e, new rb(e, b, f), k);
      }
      function yd(a, b, c, d, e, f, h) {
        var k = b.O;
        e = new rb(e, b, f);
        if (c.e())
          h = a.V.xa(b.O.j(), d, h), a = Fd(b, h, !0, a.V.Na());
        else if (f = E(c), ".priority" === f)
          h = a.V.ga(b.O.j(), d), a = Fd(b, h, k.ea, k.Ub);
        else {
          c = H(c);
          var l = k.j().R(f);
          if (!c.e()) {
            var m = e.qf(f);
            d = null != m ? ".priority" === Ld(c) && m.Q(c.parent()).e() ? m : m.G(c, d) : C;
          }
          l.ca(d) ? a = b : (h = a.V.G(k.j(), f, d, c, e, h), a = Fd(b, h, k.ea, a.V.Na()));
        }
        return a;
      }
      function Cd(a, b, c, d, e, f, h) {
        var k = b;
        Md(d, function(d, m) {
          var t = c.u(d);
          sb(b.O, E(t)) && (k = yd(a, k, t, m, e, f, h));
        });
        Md(d, function(d, m) {
          var t = c.u(d);
          sb(b.O, E(t)) || (k = yd(a, k, t, m, e, f, h));
        });
        return k;
      }
      function Nd(a, b) {
        Md(b, function(b, d) {
          a = a.G(b, d);
        });
        return a;
      }
      function Dd(a, b, c, d, e, f, h, k) {
        if (b.w().j().e() && !Ib(b.w()))
          return b;
        var l = b;
        c = c.e() ? d : Od(Pd, c, d);
        var m = b.w().j();
        c.children.ia(function(c, d) {
          if (m.Da(c)) {
            var I = b.w().j().R(c),
                I = Nd(I, d);
            l = Ad(a, l, new L(c), I, e, f, h, k);
          }
        });
        c.children.ia(function(c, d) {
          var I = !sb(b.w(), c) && null == d.value;
          m.Da(c) || I || (I = b.w().j().R(c), I = Nd(I, d), l = Ad(a, l, new L(c), I, e, f, h, k));
        });
        return l;
      }
      function Gd(a, b, c, d, e, f, h) {
        if (null != e.tc(c))
          return b;
        var k = Jb(b.w()),
            l = b.w();
        if (null != d.value) {
          if (c.e() && l.ea || Kb(l, c))
            return Ad(a, b, c, l.j().Q(c), e, f, k, h);
          if (c.e()) {
            var m = Pd;
            l.j().P(Qd, function(a, b) {
              m = m.set(new L(a), b);
            });
            return Dd(a, b, c, m, e, f, k, h);
          }
          return b;
        }
        m = Pd;
        Md(d, function(a) {
          var b = c.u(a);
          Kb(l, b) && (m = m.set(a, l.j().Q(b)));
        });
        return Dd(a, b, c, m, e, f, k, h);
      }
      ;
      function Rd() {}
      var Sd = {};
      function td(a) {
        return q(a.compare, a);
      }
      Rd.prototype.Ad = function(a, b) {
        return 0 !== this.compare(new F("[MIN_NAME]", a), new F("[MIN_NAME]", b));
      };
      Rd.prototype.Tc = function() {
        return Td;
      };
      function Ud(a) {
        K(!a.e() && ".priority" !== E(a), "Can't create PathIndex with empty path or .priority key");
        this.cc = a;
      }
      ma(Ud, Rd);
      g = Ud.prototype;
      g.Ic = function(a) {
        return !a.Q(this.cc).e();
      };
      g.compare = function(a, b) {
        var c = a.S.Q(this.cc),
            d = b.S.Q(this.cc),
            c = c.Dc(d);
        return 0 === c ? Vb(a.name, b.name) : c;
      };
      g.Pc = function(a, b) {
        var c = M(a),
            c = C.G(this.cc, c);
        return new F(b, c);
      };
      g.Qc = function() {
        var a = C.G(this.cc, Vd);
        return new F("[MAX_NAME]", a);
      };
      g.toString = function() {
        return this.cc.slice().join("/");
      };
      function Wd() {}
      ma(Wd, Rd);
      g = Wd.prototype;
      g.compare = function(a, b) {
        var c = a.S.C(),
            d = b.S.C(),
            c = c.Dc(d);
        return 0 === c ? Vb(a.name, b.name) : c;
      };
      g.Ic = function(a) {
        return !a.C().e();
      };
      g.Ad = function(a, b) {
        return !a.C().ca(b.C());
      };
      g.Tc = function() {
        return Td;
      };
      g.Qc = function() {
        return new F("[MAX_NAME]", new tc("[PRIORITY-POST]", Vd));
      };
      g.Pc = function(a, b) {
        var c = M(a);
        return new F(b, new tc("[PRIORITY-POST]", c));
      };
      g.toString = function() {
        return ".priority";
      };
      var N = new Wd;
      function Xd() {}
      ma(Xd, Rd);
      g = Xd.prototype;
      g.compare = function(a, b) {
        return Vb(a.name, b.name);
      };
      g.Ic = function() {
        throw Fc("KeyIndex.isDefinedOn not expected to be called.");
      };
      g.Ad = function() {
        return !1;
      };
      g.Tc = function() {
        return Td;
      };
      g.Qc = function() {
        return new F("[MAX_NAME]", C);
      };
      g.Pc = function(a) {
        K(p(a), "KeyIndex indexValue must always be a string.");
        return new F(a, C);
      };
      g.toString = function() {
        return ".key";
      };
      var Qd = new Xd;
      function Yd() {}
      ma(Yd, Rd);
      g = Yd.prototype;
      g.compare = function(a, b) {
        var c = a.S.Dc(b.S);
        return 0 === c ? Vb(a.name, b.name) : c;
      };
      g.Ic = function() {
        return !0;
      };
      g.Ad = function(a, b) {
        return !a.ca(b);
      };
      g.Tc = function() {
        return Td;
      };
      g.Qc = function() {
        return Zd;
      };
      g.Pc = function(a, b) {
        var c = M(a);
        return new F(b, c);
      };
      g.toString = function() {
        return ".value";
      };
      var $d = new Yd;
      function ae() {
        this.Tb = this.pa = this.Lb = this.ma = this.ja = !1;
        this.ka = 0;
        this.Nb = "";
        this.ec = null;
        this.xb = "";
        this.bc = null;
        this.vb = "";
        this.g = N;
      }
      var be = new ae;
      function rd(a) {
        return "" === a.Nb ? a.ma : "l" === a.Nb;
      }
      function nd(a) {
        K(a.ma, "Only valid if start has been set");
        return a.ec;
      }
      function md(a) {
        K(a.ma, "Only valid if start has been set");
        return a.Lb ? a.xb : "[MIN_NAME]";
      }
      function pd(a) {
        K(a.pa, "Only valid if end has been set");
        return a.bc;
      }
      function od(a) {
        K(a.pa, "Only valid if end has been set");
        return a.Tb ? a.vb : "[MAX_NAME]";
      }
      function ce(a) {
        var b = new ae;
        b.ja = a.ja;
        b.ka = a.ka;
        b.ma = a.ma;
        b.ec = a.ec;
        b.Lb = a.Lb;
        b.xb = a.xb;
        b.pa = a.pa;
        b.bc = a.bc;
        b.Tb = a.Tb;
        b.vb = a.vb;
        b.g = a.g;
        return b;
      }
      g = ae.prototype;
      g.He = function(a) {
        var b = ce(this);
        b.ja = !0;
        b.ka = a;
        b.Nb = "";
        return b;
      };
      g.Ie = function(a) {
        var b = ce(this);
        b.ja = !0;
        b.ka = a;
        b.Nb = "l";
        return b;
      };
      g.Je = function(a) {
        var b = ce(this);
        b.ja = !0;
        b.ka = a;
        b.Nb = "r";
        return b;
      };
      g.$d = function(a, b) {
        var c = ce(this);
        c.ma = !0;
        n(a) || (a = null);
        c.ec = a;
        null != b ? (c.Lb = !0, c.xb = b) : (c.Lb = !1, c.xb = "");
        return c;
      };
      g.td = function(a, b) {
        var c = ce(this);
        c.pa = !0;
        n(a) || (a = null);
        c.bc = a;
        n(b) ? (c.Tb = !0, c.vb = b) : (c.ah = !1, c.vb = "");
        return c;
      };
      function de(a, b) {
        var c = ce(a);
        c.g = b;
        return c;
      }
      function ee(a) {
        var b = {};
        a.ma && (b.sp = a.ec, a.Lb && (b.sn = a.xb));
        a.pa && (b.ep = a.bc, a.Tb && (b.en = a.vb));
        if (a.ja) {
          b.l = a.ka;
          var c = a.Nb;
          "" === c && (c = rd(a) ? "l" : "r");
          b.vf = c;
        }
        a.g !== N && (b.i = a.g.toString());
        return b;
      }
      function S(a) {
        return !(a.ma || a.pa || a.ja);
      }
      function fe(a) {
        return S(a) && a.g == N;
      }
      function ge(a) {
        var b = {};
        if (fe(a))
          return b;
        var c;
        a.g === N ? c = "$priority" : a.g === $d ? c = "$value" : a.g === Qd ? c = "$key" : (K(a.g instanceof Ud, "Unrecognized index type!"), c = a.g.toString());
        b.orderBy = B(c);
        a.ma && (b.startAt = B(a.ec), a.Lb && (b.startAt += "," + B(a.xb)));
        a.pa && (b.endAt = B(a.bc), a.Tb && (b.endAt += "," + B(a.vb)));
        a.ja && (rd(a) ? b.limitToFirst = a.ka : b.limitToLast = a.ka);
        return b;
      }
      g.toString = function() {
        return B(ee(this));
      };
      function he(a, b) {
        this.Bd = a;
        this.dc = b;
      }
      he.prototype.get = function(a) {
        var b = w(this.Bd, a);
        if (!b)
          throw Error("No index defined for " + a);
        return b === Sd ? null : b;
      };
      function ie(a, b, c) {
        var d = na(a.Bd, function(d, f) {
          var h = w(a.dc, f);
          K(h, "Missing index implementation for " + f);
          if (d === Sd) {
            if (h.Ic(b.S)) {
              for (var k = [],
                  l = c.Xb(Tb),
                  m = J(l); m; )
                m.name != b.name && k.push(m), m = J(l);
              k.push(b);
              return je(k, td(h));
            }
            return Sd;
          }
          h = c.get(b.name);
          k = d;
          h && (k = k.remove(new F(b.name, h)));
          return k.Oa(b, b.S);
        });
        return new he(d, a.dc);
      }
      function ke(a, b, c) {
        var d = na(a.Bd, function(a) {
          if (a === Sd)
            return a;
          var d = c.get(b.name);
          return d ? a.remove(new F(b.name, d)) : a;
        });
        return new he(d, a.dc);
      }
      var le = new he({".priority": Sd}, {".priority": N});
      function tc(a, b) {
        this.B = a;
        K(n(this.B) && null !== this.B, "LeafNode shouldn't be created with null/undefined value.");
        this.aa = b || C;
        me(this.aa);
        this.Cb = null;
      }
      var ne = ["object", "boolean", "number", "string"];
      g = tc.prototype;
      g.K = function() {
        return !0;
      };
      g.C = function() {
        return this.aa;
      };
      g.ga = function(a) {
        return new tc(this.B, a);
      };
      g.R = function(a) {
        return ".priority" === a ? this.aa : C;
      };
      g.Q = function(a) {
        return a.e() ? this : ".priority" === E(a) ? this.aa : C;
      };
      g.Da = function() {
        return !1;
      };
      g.rf = function() {
        return null;
      };
      g.U = function(a, b) {
        return ".priority" === a ? this.ga(b) : b.e() && ".priority" !== a ? this : C.U(a, b).ga(this.aa);
      };
      g.G = function(a, b) {
        var c = E(a);
        if (null === c)
          return b;
        if (b.e() && ".priority" !== c)
          return this;
        K(".priority" !== c || 1 === Kd(a), ".priority must be the last token in a path");
        return this.U(c, C.G(H(a), b));
      };
      g.e = function() {
        return !1;
      };
      g.Db = function() {
        return 0;
      };
      g.P = function() {
        return !1;
      };
      g.I = function(a) {
        return a && !this.C().e() ? {
          ".value": this.Ca(),
          ".priority": this.C().I()
        } : this.Ca();
      };
      g.hash = function() {
        if (null === this.Cb) {
          var a = "";
          this.aa.e() || (a += "priority:" + oe(this.aa.I()) + ":");
          var b = typeof this.B,
              a = a + (b + ":"),
              a = "number" === b ? a + Xc(this.B) : a + this.B;
          this.Cb = Hc(a);
        }
        return this.Cb;
      };
      g.Ca = function() {
        return this.B;
      };
      g.Dc = function(a) {
        if (a === C)
          return 1;
        if (a instanceof R)
          return -1;
        K(a.K(), "Unknown node type");
        var b = typeof a.B,
            c = typeof this.B,
            d = Na(ne, b),
            e = Na(ne, c);
        K(0 <= d, "Unknown leaf type: " + b);
        K(0 <= e, "Unknown leaf type: " + c);
        return d === e ? "object" === c ? 0 : this.B < a.B ? -1 : this.B === a.B ? 0 : 1 : e - d;
      };
      g.lb = function() {
        return this;
      };
      g.Jc = function() {
        return !0;
      };
      g.ca = function(a) {
        return a === this ? !0 : a.K() ? this.B === a.B && this.aa.ca(a.aa) : !1;
      };
      g.toString = function() {
        return B(this.I(!0));
      };
      function R(a, b, c) {
        this.m = a;
        (this.aa = b) && me(this.aa);
        a.e() && K(!this.aa || this.aa.e(), "An empty node cannot have a priority");
        this.wb = c;
        this.Cb = null;
      }
      g = R.prototype;
      g.K = function() {
        return !1;
      };
      g.C = function() {
        return this.aa || C;
      };
      g.ga = function(a) {
        return this.m.e() ? this : new R(this.m, a, this.wb);
      };
      g.R = function(a) {
        if (".priority" === a)
          return this.C();
        a = this.m.get(a);
        return null === a ? C : a;
      };
      g.Q = function(a) {
        var b = E(a);
        return null === b ? this : this.R(b).Q(H(a));
      };
      g.Da = function(a) {
        return null !== this.m.get(a);
      };
      g.U = function(a, b) {
        K(b, "We should always be passing snapshot nodes");
        if (".priority" === a)
          return this.ga(b);
        var c = new F(a, b),
            d,
            e;
        b.e() ? (d = this.m.remove(a), c = ke(this.wb, c, this.m)) : (d = this.m.Oa(a, b), c = ie(this.wb, c, this.m));
        e = d.e() ? C : this.aa;
        return new R(d, e, c);
      };
      g.G = function(a, b) {
        var c = E(a);
        if (null === c)
          return b;
        K(".priority" !== E(a) || 1 === Kd(a), ".priority must be the last token in a path");
        var d = this.R(c).G(H(a), b);
        return this.U(c, d);
      };
      g.e = function() {
        return this.m.e();
      };
      g.Db = function() {
        return this.m.count();
      };
      var pe = /^(0|[1-9]\d*)$/;
      g = R.prototype;
      g.I = function(a) {
        if (this.e())
          return null;
        var b = {},
            c = 0,
            d = 0,
            e = !0;
        this.P(N, function(f, h) {
          b[f] = h.I(a);
          c++;
          e && pe.test(f) ? d = Math.max(d, Number(f)) : e = !1;
        });
        if (!a && e && d < 2 * c) {
          var f = [],
              h;
          for (h in b)
            f[h] = b[h];
          return f;
        }
        a && !this.C().e() && (b[".priority"] = this.C().I());
        return b;
      };
      g.hash = function() {
        if (null === this.Cb) {
          var a = "";
          this.C().e() || (a += "priority:" + oe(this.C().I()) + ":");
          this.P(N, function(b, c) {
            var d = c.hash();
            "" !== d && (a += ":" + b + ":" + d);
          });
          this.Cb = "" === a ? "" : Hc(a);
        }
        return this.Cb;
      };
      g.rf = function(a, b, c) {
        return (c = qe(this, c)) ? (a = cc(c, new F(a, b))) ? a.name : null : cc(this.m, a);
      };
      function ud(a, b) {
        var c;
        c = (c = qe(a, b)) ? (c = c.Sc()) && c.name : a.m.Sc();
        return c ? new F(c, a.m.get(c)) : null;
      }
      function vd(a, b) {
        var c;
        c = (c = qe(a, b)) ? (c = c.fc()) && c.name : a.m.fc();
        return c ? new F(c, a.m.get(c)) : null;
      }
      g.P = function(a, b) {
        var c = qe(this, a);
        return c ? c.ia(function(a) {
          return b(a.name, a.S);
        }) : this.m.ia(b);
      };
      g.Xb = function(a) {
        return this.Yb(a.Tc(), a);
      };
      g.Yb = function(a, b) {
        var c = qe(this, b);
        if (c)
          return c.Yb(a, function(a) {
            return a;
          });
        for (var c = this.m.Yb(a.name, Tb),
            d = ec(c); null != d && 0 > b.compare(d, a); )
          J(c), d = ec(c);
        return c;
      };
      g.sf = function(a) {
        return this.$b(a.Qc(), a);
      };
      g.$b = function(a, b) {
        var c = qe(this, b);
        if (c)
          return c.$b(a, function(a) {
            return a;
          });
        for (var c = this.m.$b(a.name, Tb),
            d = ec(c); null != d && 0 < b.compare(d, a); )
          J(c), d = ec(c);
        return c;
      };
      g.Dc = function(a) {
        return this.e() ? a.e() ? 0 : -1 : a.K() || a.e() ? 1 : a === Vd ? -1 : 0;
      };
      g.lb = function(a) {
        if (a === Qd || ta(this.wb.dc, a.toString()))
          return this;
        var b = this.wb,
            c = this.m;
        K(a !== Qd, "KeyIndex always exists and isn't meant to be added to the IndexMap.");
        for (var d = [],
            e = !1,
            c = c.Xb(Tb),
            f = J(c); f; )
          e = e || a.Ic(f.S), d.push(f), f = J(c);
        d = e ? je(d, td(a)) : Sd;
        e = a.toString();
        c = xa(b.dc);
        c[e] = a;
        a = xa(b.Bd);
        a[e] = d;
        return new R(this.m, this.aa, new he(a, c));
      };
      g.Jc = function(a) {
        return a === Qd || ta(this.wb.dc, a.toString());
      };
      g.ca = function(a) {
        if (a === this)
          return !0;
        if (a.K())
          return !1;
        if (this.C().ca(a.C()) && this.m.count() === a.m.count()) {
          var b = this.Xb(N);
          a = a.Xb(N);
          for (var c = J(b),
              d = J(a); c && d; ) {
            if (c.name !== d.name || !c.S.ca(d.S))
              return !1;
            c = J(b);
            d = J(a);
          }
          return null === c && null === d;
        }
        return !1;
      };
      function qe(a, b) {
        return b === Qd ? null : a.wb.get(b.toString());
      }
      g.toString = function() {
        return B(this.I(!0));
      };
      function M(a, b) {
        if (null === a)
          return C;
        var c = null;
        "object" === typeof a && ".priority" in a ? c = a[".priority"] : "undefined" !== typeof b && (c = b);
        K(null === c || "string" === typeof c || "number" === typeof c || "object" === typeof c && ".sv" in c, "Invalid priority type found: " + typeof c);
        "object" === typeof a && ".value" in a && null !== a[".value"] && (a = a[".value"]);
        if ("object" !== typeof a || ".sv" in a)
          return new tc(a, M(c));
        if (a instanceof Array) {
          var d = C,
              e = a;
          r(e, function(a, b) {
            if (v(e, b) && "." !== b.substring(0, 1)) {
              var c = M(a);
              if (c.K() || !c.e())
                d = d.U(b, c);
            }
          });
          return d.ga(M(c));
        }
        var f = [],
            h = !1,
            k = a;
        ib(k, function(a) {
          if ("string" !== typeof a || "." !== a.substring(0, 1)) {
            var b = M(k[a]);
            b.e() || (h = h || !b.C().e(), f.push(new F(a, b)));
          }
        });
        if (0 == f.length)
          return C;
        var l = je(f, Ub, function(a) {
          return a.name;
        }, Wb);
        if (h) {
          var m = je(f, td(N));
          return new R(l, M(c), new he({".priority": m}, {".priority": N}));
        }
        return new R(l, M(c), le);
      }
      var re = Math.log(2);
      function se(a) {
        this.count = parseInt(Math.log(a + 1) / re, 10);
        this.jf = this.count - 1;
        this.eg = a + 1 & parseInt(Array(this.count + 1).join("1"), 2);
      }
      function te(a) {
        var b = !(a.eg & 1 << a.jf);
        a.jf--;
        return b;
      }
      function je(a, b, c, d) {
        function e(b, d) {
          var f = d - b;
          if (0 == f)
            return null;
          if (1 == f) {
            var m = a[b],
                t = c ? c(m) : m;
            return new fc(t, m.S, !1, null, null);
          }
          var m = parseInt(f / 2, 10) + b,
              f = e(b, m),
              z = e(m + 1, d),
              m = a[m],
              t = c ? c(m) : m;
          return new fc(t, m.S, !1, f, z);
        }
        a.sort(b);
        var f = function(b) {
          function d(b, h) {
            var k = t - b,
                z = t;
            t -= b;
            var z = e(k + 1, z),
                k = a[k],
                I = c ? c(k) : k,
                z = new fc(I, k.S, h, null, z);
            f ? f.left = z : m = z;
            f = z;
          }
          for (var f = null,
              m = null,
              t = a.length,
              z = 0; z < b.count; ++z) {
            var I = te(b),
                zd = Math.pow(2, b.count - (z + 1));
            I ? d(zd, !1) : (d(zd, !1), d(zd, !0));
          }
          return m;
        }(new se(a.length));
        return null !== f ? new ac(d || b, f) : new ac(d || b);
      }
      function oe(a) {
        return "number" === typeof a ? "number:" + Xc(a) : "string:" + a;
      }
      function me(a) {
        if (a.K()) {
          var b = a.I();
          K("string" === typeof b || "number" === typeof b || "object" === typeof b && v(b, ".sv"), "Priority must be a string or number.");
        } else
          K(a === Vd || a.e(), "priority of unexpected type.");
        K(a === Vd || a.C().e(), "Priority nodes can't have a priority of their own.");
      }
      var C = new R(new ac(Wb), null, le);
      function ue() {
        R.call(this, new ac(Wb), C, le);
      }
      ma(ue, R);
      g = ue.prototype;
      g.Dc = function(a) {
        return a === this ? 0 : 1;
      };
      g.ca = function(a) {
        return a === this;
      };
      g.C = function() {
        return this;
      };
      g.R = function() {
        return C;
      };
      g.e = function() {
        return !1;
      };
      var Vd = new ue,
          Td = new F("[MIN_NAME]", C),
          Zd = new F("[MAX_NAME]", Vd);
      function Id(a, b) {
        this.O = a;
        this.Yd = b;
      }
      function Fd(a, b, c, d) {
        return new Id(new tb(b, c, d), a.Yd);
      }
      function Jd(a) {
        return a.O.ea ? a.O.j() : null;
      }
      Id.prototype.w = function() {
        return this.Yd;
      };
      function ub(a) {
        return a.Yd.ea ? a.Yd.j() : null;
      }
      ;
      function ve(a, b) {
        this.W = a;
        var c = a.n,
            d = new kd(c.g),
            c = S(c) ? new kd(c.g) : c.ja ? new qd(c) : new ld(c);
        this.Hf = new xd(c);
        var e = b.w(),
            f = b.O,
            h = d.xa(C, e.j(), null),
            k = c.xa(C, f.j(), null);
        this.Ka = new Id(new tb(k, f.ea, c.Na()), new tb(h, e.ea, d.Na()));
        this.Xa = [];
        this.lg = new cd(a);
      }
      function we(a) {
        return a.W;
      }
      g = ve.prototype;
      g.w = function() {
        return this.Ka.w().j();
      };
      g.fb = function(a) {
        var b = ub(this.Ka);
        return b && (S(this.W.n) || !a.e() && !b.R(E(a)).e()) ? b.Q(a) : null;
      };
      g.e = function() {
        return 0 === this.Xa.length;
      };
      g.Pb = function(a) {
        this.Xa.push(a);
      };
      g.jb = function(a, b) {
        var c = [];
        if (b) {
          K(null == a, "A cancel should cancel all event registrations.");
          var d = this.W.path;
          Oa(this.Xa, function(a) {
            (a = a.gf(b, d)) && c.push(a);
          });
        }
        if (a) {
          for (var e = [],
              f = 0; f < this.Xa.length; ++f) {
            var h = this.Xa[f];
            if (!h.matches(a))
              e.push(h);
            else if (a.tf()) {
              e = e.concat(this.Xa.slice(f + 1));
              break;
            }
          }
          this.Xa = e;
        } else
          this.Xa = [];
        return c;
      };
      g.ab = function(a, b, c) {
        a.type === Bd && null !== a.source.Hb && (K(ub(this.Ka), "We should always have a full cache before handling merges"), K(Jd(this.Ka), "Missing event cache, even though we have a server cache"));
        var d = this.Ka;
        a = this.Hf.ab(d, a, b, c);
        b = this.Hf;
        c = a.je;
        K(c.O.j().Jc(b.V.g), "Event snap not indexed");
        K(c.w().j().Jc(b.V.g), "Server snap not indexed");
        K(Ib(a.je.w()) || !Ib(d.w()), "Once a server snap is complete, it should never go back");
        this.Ka = a.je;
        return xe(this, a.fg, a.je.O.j(), null);
      };
      function ye(a, b) {
        var c = a.Ka.O,
            d = [];
        c.j().K() || c.j().P(N, function(a, b) {
          d.push(new D("child_added", b, a));
        });
        c.ea && d.push(Eb(c.j()));
        return xe(a, d, c.j(), b);
      }
      function xe(a, b, c, d) {
        return dd(a.lg, b, c, d ? [d] : a.Xa);
      }
      ;
      function ze(a, b, c) {
        this.type = Bd;
        this.source = a;
        this.path = b;
        this.children = c;
      }
      ze.prototype.Xc = function(a) {
        if (this.path.e())
          return a = this.children.subtree(new L(a)), a.e() ? null : a.value ? new Xb(this.source, G, a.value) : new ze(this.source, G, a);
        K(E(this.path) === a, "Can't get a merge for a child not on the path of the operation");
        return new ze(this.source, H(this.path), this.children);
      };
      ze.prototype.toString = function() {
        return "Operation(" + this.path + ": " + this.source.toString() + " merge: " + this.children.toString() + ")";
      };
      function Ae(a, b) {
        this.f = Mc("p:rest:");
        this.F = a;
        this.Gb = b;
        this.Aa = null;
        this.$ = {};
      }
      function Be(a, b) {
        if (n(b))
          return "tag$" + b;
        K(fe(a.n), "should have a tag if it's not a default query.");
        return a.path.toString();
      }
      g = Ae.prototype;
      g.yf = function(a, b, c, d) {
        var e = a.path.toString();
        this.f("Listen called for " + e + " " + a.va());
        var f = Be(a, c),
            h = {};
        this.$[f] = h;
        a = ge(a.n);
        var k = this;
        Ce(this, e + ".json", a, function(a, b) {
          var t = b;
          404 === a && (a = t = null);
          null === a && k.Gb(e, t, !1, c);
          w(k.$, f) === h && d(a ? 401 == a ? "permission_denied" : "rest_error:" + a : "ok", null);
        });
      };
      g.Rf = function(a, b) {
        var c = Be(a, b);
        delete this.$[c];
      };
      g.M = function(a, b) {
        this.Aa = a;
        var c = $c(a),
            d = c.data,
            c = c.Bc && c.Bc.exp;
        b && b("ok", {
          auth: d,
          expires: c
        });
      };
      g.ge = function(a) {
        this.Aa = null;
        a("ok", null);
      };
      g.Me = function() {};
      g.Cf = function() {};
      g.Jd = function() {};
      g.put = function() {};
      g.zf = function() {};
      g.Ue = function() {};
      function Ce(a, b, c, d) {
        c = c || {};
        c.format = "export";
        a.Aa && (c.auth = a.Aa);
        var e = (a.F.kb ? "https://" : "http://") + a.F.host + b + "?" + kb(c);
        a.f("Sending REST request for " + e);
        var f = new XMLHttpRequest;
        f.onreadystatechange = function() {
          if (d && 4 === f.readyState) {
            a.f("REST Response for " + e + " received. status:", f.status, "response:", f.responseText);
            var b = null;
            if (200 <= f.status && 300 > f.status) {
              try {
                b = nb(f.responseText);
              } catch (c) {
                O("Failed to parse JSON response for " + e + ": " + f.responseText);
              }
              d(null, b);
            } else
              401 !== f.status && 404 !== f.status && O("Got unsuccessful REST response for " + e + " Status: " + f.status), d(f.status);
            d = null;
          }
        };
        f.open("GET", e, !0);
        f.send();
      }
      ;
      function De(a) {
        K(ea(a) && 0 < a.length, "Requires a non-empty array");
        this.Xf = a;
        this.Oc = {};
      }
      De.prototype.fe = function(a, b) {
        var c;
        c = this.Oc[a] || [];
        var d = c.length;
        if (0 < d) {
          for (var e = Array(d),
              f = 0; f < d; f++)
            e[f] = c[f];
          c = e;
        } else
          c = [];
        for (d = 0; d < c.length; d++)
          c[d].zc.apply(c[d].Ma, Array.prototype.slice.call(arguments, 1));
      };
      De.prototype.Eb = function(a, b, c) {
        Ee(this, a);
        this.Oc[a] = this.Oc[a] || [];
        this.Oc[a].push({
          zc: b,
          Ma: c
        });
        (a = this.Ae(a)) && b.apply(c, a);
      };
      De.prototype.ic = function(a, b, c) {
        Ee(this, a);
        a = this.Oc[a] || [];
        for (var d = 0; d < a.length; d++)
          if (a[d].zc === b && (!c || c === a[d].Ma)) {
            a.splice(d, 1);
            break;
          }
      };
      function Ee(a, b) {
        K(Ta(a.Xf, function(a) {
          return a === b;
        }), "Unknown event: " + b);
      }
      ;
      var Fe = function() {
        var a = 0,
            b = [];
        return function(c) {
          var d = c === a;
          a = c;
          for (var e = Array(8),
              f = 7; 0 <= f; f--)
            e[f] = "-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz".charAt(c % 64), c = Math.floor(c / 64);
          K(0 === c, "Cannot push at time == 0");
          c = e.join("");
          if (d) {
            for (f = 11; 0 <= f && 63 === b[f]; f--)
              b[f] = 0;
            b[f]++;
          } else
            for (f = 0; 12 > f; f++)
              b[f] = Math.floor(64 * Math.random());
          for (f = 0; 12 > f; f++)
            c += "-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz".charAt(b[f]);
          K(20 === c.length, "nextPushId: Length should be 20.");
          return c;
        };
      }();
      function Ge() {
        De.call(this, ["online"]);
        this.kc = !0;
        if ("undefined" !== typeof window && "undefined" !== typeof window.addEventListener) {
          var a = this;
          window.addEventListener("online", function() {
            a.kc || (a.kc = !0, a.fe("online", !0));
          }, !1);
          window.addEventListener("offline", function() {
            a.kc && (a.kc = !1, a.fe("online", !1));
          }, !1);
        }
      }
      ma(Ge, De);
      Ge.prototype.Ae = function(a) {
        K("online" === a, "Unknown event type: " + a);
        return [this.kc];
      };
      ca(Ge);
      function He() {
        De.call(this, ["visible"]);
        var a,
            b;
        "undefined" !== typeof document && "undefined" !== typeof document.addEventListener && ("undefined" !== typeof document.hidden ? (b = "visibilitychange", a = "hidden") : "undefined" !== typeof document.mozHidden ? (b = "mozvisibilitychange", a = "mozHidden") : "undefined" !== typeof document.msHidden ? (b = "msvisibilitychange", a = "msHidden") : "undefined" !== typeof document.webkitHidden && (b = "webkitvisibilitychange", a = "webkitHidden"));
        this.Ob = !0;
        if (b) {
          var c = this;
          document.addEventListener(b, function() {
            var b = !document[a];
            b !== c.Ob && (c.Ob = b, c.fe("visible", b));
          }, !1);
        }
      }
      ma(He, De);
      He.prototype.Ae = function(a) {
        K("visible" === a, "Unknown event type: " + a);
        return [this.Ob];
      };
      ca(He);
      function L(a, b) {
        if (1 == arguments.length) {
          this.o = a.split("/");
          for (var c = 0,
              d = 0; d < this.o.length; d++)
            0 < this.o[d].length && (this.o[c] = this.o[d], c++);
          this.o.length = c;
          this.Z = 0;
        } else
          this.o = a, this.Z = b;
      }
      function T(a, b) {
        var c = E(a);
        if (null === c)
          return b;
        if (c === E(b))
          return T(H(a), H(b));
        throw Error("INTERNAL ERROR: innerPath (" + b + ") is not within outerPath (" + a + ")");
      }
      function Ie(a, b) {
        for (var c = a.slice(),
            d = b.slice(),
            e = 0; e < c.length && e < d.length; e++) {
          var f = Vb(c[e], d[e]);
          if (0 !== f)
            return f;
        }
        return c.length === d.length ? 0 : c.length < d.length ? -1 : 1;
      }
      function E(a) {
        return a.Z >= a.o.length ? null : a.o[a.Z];
      }
      function Kd(a) {
        return a.o.length - a.Z;
      }
      function H(a) {
        var b = a.Z;
        b < a.o.length && b++;
        return new L(a.o, b);
      }
      function Ld(a) {
        return a.Z < a.o.length ? a.o[a.o.length - 1] : null;
      }
      g = L.prototype;
      g.toString = function() {
        for (var a = "",
            b = this.Z; b < this.o.length; b++)
          "" !== this.o[b] && (a += "/" + this.o[b]);
        return a || "/";
      };
      g.slice = function(a) {
        return this.o.slice(this.Z + (a || 0));
      };
      g.parent = function() {
        if (this.Z >= this.o.length)
          return null;
        for (var a = [],
            b = this.Z; b < this.o.length - 1; b++)
          a.push(this.o[b]);
        return new L(a, 0);
      };
      g.u = function(a) {
        for (var b = [],
            c = this.Z; c < this.o.length; c++)
          b.push(this.o[c]);
        if (a instanceof L)
          for (c = a.Z; c < a.o.length; c++)
            b.push(a.o[c]);
        else
          for (a = a.split("/"), c = 0; c < a.length; c++)
            0 < a[c].length && b.push(a[c]);
        return new L(b, 0);
      };
      g.e = function() {
        return this.Z >= this.o.length;
      };
      g.ca = function(a) {
        if (Kd(this) !== Kd(a))
          return !1;
        for (var b = this.Z,
            c = a.Z; b <= this.o.length; b++, c++)
          if (this.o[b] !== a.o[c])
            return !1;
        return !0;
      };
      g.contains = function(a) {
        var b = this.Z,
            c = a.Z;
        if (Kd(this) > Kd(a))
          return !1;
        for (; b < this.o.length; ) {
          if (this.o[b] !== a.o[c])
            return !1;
          ++b;
          ++c;
        }
        return !0;
      };
      var G = new L("");
      function Je(a, b) {
        this.Qa = a.slice();
        this.Ha = Math.max(1, this.Qa.length);
        this.lf = b;
        for (var c = 0; c < this.Qa.length; c++)
          this.Ha += Zc(this.Qa[c]);
        Ke(this);
      }
      Je.prototype.push = function(a) {
        0 < this.Qa.length && (this.Ha += 1);
        this.Qa.push(a);
        this.Ha += Zc(a);
        Ke(this);
      };
      Je.prototype.pop = function() {
        var a = this.Qa.pop();
        this.Ha -= Zc(a);
        0 < this.Qa.length && --this.Ha;
      };
      function Ke(a) {
        if (768 < a.Ha)
          throw Error(a.lf + "has a key path longer than 768 bytes (" + a.Ha + ").");
        if (32 < a.Qa.length)
          throw Error(a.lf + "path specified exceeds the maximum depth that can be written (32) or object contains a cycle " + Le(a));
      }
      function Le(a) {
        return 0 == a.Qa.length ? "" : "in property '" + a.Qa.join(".") + "'";
      }
      ;
      function Me(a, b) {
        this.value = a;
        this.children = b || Ne;
      }
      var Ne = new ac(function(a, b) {
        return a === b ? 0 : a < b ? -1 : 1;
      });
      function Oe(a) {
        var b = Pd;
        r(a, function(a, d) {
          b = b.set(new L(d), a);
        });
        return b;
      }
      g = Me.prototype;
      g.e = function() {
        return null === this.value && this.children.e();
      };
      function Pe(a, b, c) {
        if (null != a.value && c(a.value))
          return {
            path: G,
            value: a.value
          };
        if (b.e())
          return null;
        var d = E(b);
        a = a.children.get(d);
        return null !== a ? (b = Pe(a, H(b), c), null != b ? {
          path: (new L(d)).u(b.path),
          value: b.value
        } : null) : null;
      }
      function Qe(a, b) {
        return Pe(a, b, function() {
          return !0;
        });
      }
      g.subtree = function(a) {
        if (a.e())
          return this;
        var b = this.children.get(E(a));
        return null !== b ? b.subtree(H(a)) : Pd;
      };
      g.set = function(a, b) {
        if (a.e())
          return new Me(b, this.children);
        var c = E(a),
            d = (this.children.get(c) || Pd).set(H(a), b),
            c = this.children.Oa(c, d);
        return new Me(this.value, c);
      };
      g.remove = function(a) {
        if (a.e())
          return this.children.e() ? Pd : new Me(null, this.children);
        var b = E(a),
            c = this.children.get(b);
        return c ? (a = c.remove(H(a)), b = a.e() ? this.children.remove(b) : this.children.Oa(b, a), null === this.value && b.e() ? Pd : new Me(this.value, b)) : this;
      };
      g.get = function(a) {
        if (a.e())
          return this.value;
        var b = this.children.get(E(a));
        return b ? b.get(H(a)) : null;
      };
      function Od(a, b, c) {
        if (b.e())
          return c;
        var d = E(b);
        b = Od(a.children.get(d) || Pd, H(b), c);
        d = b.e() ? a.children.remove(d) : a.children.Oa(d, b);
        return new Me(a.value, d);
      }
      function Re(a, b) {
        return Se(a, G, b);
      }
      function Se(a, b, c) {
        var d = {};
        a.children.ia(function(a, f) {
          d[a] = Se(f, b.u(a), c);
        });
        return c(b, a.value, d);
      }
      function Te(a, b, c) {
        return Ue(a, b, G, c);
      }
      function Ue(a, b, c, d) {
        var e = a.value ? d(c, a.value) : !1;
        if (e)
          return e;
        if (b.e())
          return null;
        e = E(b);
        return (a = a.children.get(e)) ? Ue(a, H(b), c.u(e), d) : null;
      }
      function Ve(a, b, c) {
        We(a, b, G, c);
      }
      function We(a, b, c, d) {
        if (b.e())
          return a;
        a.value && d(c, a.value);
        var e = E(b);
        return (a = a.children.get(e)) ? We(a, H(b), c.u(e), d) : Pd;
      }
      function Md(a, b) {
        Xe(a, G, b);
      }
      function Xe(a, b, c) {
        a.children.ia(function(a, e) {
          Xe(e, b.u(a), c);
        });
        a.value && c(b, a.value);
      }
      function Ye(a, b) {
        a.children.ia(function(a, d) {
          d.value && b(a, d.value);
        });
      }
      var Pd = new Me(null);
      Me.prototype.toString = function() {
        var a = {};
        Md(this, function(b, c) {
          a[b.toString()] = c.toString();
        });
        return B(a);
      };
      function Ze(a, b, c) {
        this.type = Ed;
        this.source = $e;
        this.path = a;
        this.Qb = b;
        this.Vd = c;
      }
      Ze.prototype.Xc = function(a) {
        if (this.path.e()) {
          if (null != this.Qb.value)
            return K(this.Qb.children.e(), "affectedTree should not have overlapping affected paths."), this;
          a = this.Qb.subtree(new L(a));
          return new Ze(G, a, this.Vd);
        }
        K(E(this.path) === a, "operationForChild called for unrelated child.");
        return new Ze(H(this.path), this.Qb, this.Vd);
      };
      Ze.prototype.toString = function() {
        return "Operation(" + this.path + ": " + this.source.toString() + " ack write revert=" + this.Vd + " affectedTree=" + this.Qb + ")";
      };
      var Yb = 0,
          Bd = 1,
          Ed = 2,
          $b = 3;
      function af(a, b, c, d) {
        this.we = a;
        this.pf = b;
        this.Hb = c;
        this.af = d;
        K(!d || b, "Tagged queries must be from server.");
      }
      var $e = new af(!0, !1, null, !1),
          bf = new af(!1, !0, null, !1);
      af.prototype.toString = function() {
        return this.we ? "user" : this.af ? "server(queryID=" + this.Hb + ")" : "server";
      };
      function cf(a) {
        this.X = a;
      }
      var df = new cf(new Me(null));
      function ef(a, b, c) {
        if (b.e())
          return new cf(new Me(c));
        var d = Qe(a.X, b);
        if (null != d) {
          var e = d.path,
              d = d.value;
          b = T(e, b);
          d = d.G(b, c);
          return new cf(a.X.set(e, d));
        }
        a = Od(a.X, b, new Me(c));
        return new cf(a);
      }
      function ff(a, b, c) {
        var d = a;
        ib(c, function(a, c) {
          d = ef(d, b.u(a), c);
        });
        return d;
      }
      cf.prototype.Rd = function(a) {
        if (a.e())
          return df;
        a = Od(this.X, a, Pd);
        return new cf(a);
      };
      function gf(a, b) {
        var c = Qe(a.X, b);
        return null != c ? a.X.get(c.path).Q(T(c.path, b)) : null;
      }
      function hf(a) {
        var b = [],
            c = a.X.value;
        null != c ? c.K() || c.P(N, function(a, c) {
          b.push(new F(a, c));
        }) : a.X.children.ia(function(a, c) {
          null != c.value && b.push(new F(a, c.value));
        });
        return b;
      }
      function jf(a, b) {
        if (b.e())
          return a;
        var c = gf(a, b);
        return null != c ? new cf(new Me(c)) : new cf(a.X.subtree(b));
      }
      cf.prototype.e = function() {
        return this.X.e();
      };
      cf.prototype.apply = function(a) {
        return kf(G, this.X, a);
      };
      function kf(a, b, c) {
        if (null != b.value)
          return c.G(a, b.value);
        var d = null;
        b.children.ia(function(b, f) {
          ".priority" === b ? (K(null !== f.value, "Priority writes must always be leaf nodes"), d = f.value) : c = kf(a.u(b), f, c);
        });
        c.Q(a).e() || null === d || (c = c.G(a.u(".priority"), d));
        return c;
      }
      ;
      function lf() {
        this.T = df;
        this.na = [];
        this.Mc = -1;
      }
      function mf(a, b) {
        for (var c = 0; c < a.na.length; c++) {
          var d = a.na[c];
          if (d.kd === b)
            return d;
        }
        return null;
      }
      g = lf.prototype;
      g.Rd = function(a) {
        var b = Ua(this.na, function(b) {
          return b.kd === a;
        });
        K(0 <= b, "removeWrite called with nonexistent writeId.");
        var c = this.na[b];
        this.na.splice(b, 1);
        for (var d = c.visible,
            e = !1,
            f = this.na.length - 1; d && 0 <= f; ) {
          var h = this.na[f];
          h.visible && (f >= b && nf(h, c.path) ? d = !1 : c.path.contains(h.path) && (e = !0));
          f--;
        }
        if (d) {
          if (e)
            this.T = of(this.na, pf, G), this.Mc = 0 < this.na.length ? this.na[this.na.length - 1].kd : -1;
          else if (c.Ga)
            this.T = this.T.Rd(c.path);
          else {
            var k = this;
            r(c.children, function(a, b) {
              k.T = k.T.Rd(c.path.u(b));
            });
          }
          return !0;
        }
        return !1;
      };
      g.za = function(a, b, c, d) {
        if (c || d) {
          var e = jf(this.T, a);
          return !d && e.e() ? b : d || null != b || null != gf(e, G) ? (e = of(this.na, function(b) {
            return (b.visible || d) && (!c || !(0 <= Na(c, b.kd))) && (b.path.contains(a) || a.contains(b.path));
          }, a), b = b || C, e.apply(b)) : null;
        }
        e = gf(this.T, a);
        if (null != e)
          return e;
        e = jf(this.T, a);
        return e.e() ? b : null != b || null != gf(e, G) ? (b = b || C, e.apply(b)) : null;
      };
      g.yc = function(a, b) {
        var c = C,
            d = gf(this.T, a);
        if (d)
          d.K() || d.P(N, function(a, b) {
            c = c.U(a, b);
          });
        else if (b) {
          var e = jf(this.T, a);
          b.P(N, function(a, b) {
            var d = jf(e, new L(a)).apply(b);
            c = c.U(a, d);
          });
          Oa(hf(e), function(a) {
            c = c.U(a.name, a.S);
          });
        } else
          e = jf(this.T, a), Oa(hf(e), function(a) {
            c = c.U(a.name, a.S);
          });
        return c;
      };
      g.ld = function(a, b, c, d) {
        K(c || d, "Either existingEventSnap or existingServerSnap must exist");
        a = a.u(b);
        if (null != gf(this.T, a))
          return null;
        a = jf(this.T, a);
        return a.e() ? d.Q(b) : a.apply(d.Q(b));
      };
      g.xc = function(a, b, c) {
        a = a.u(b);
        var d = gf(this.T, a);
        return null != d ? d : sb(c, b) ? jf(this.T, a).apply(c.j().R(b)) : null;
      };
      g.tc = function(a) {
        return gf(this.T, a);
      };
      g.ne = function(a, b, c, d, e, f) {
        var h;
        a = jf(this.T, a);
        h = gf(a, G);
        if (null == h)
          if (null != b)
            h = a.apply(b);
          else
            return [];
        h = h.lb(f);
        if (h.e() || h.K())
          return [];
        b = [];
        a = td(f);
        e = e ? h.$b(c, f) : h.Yb(c, f);
        for (f = J(e); f && b.length < d; )
          0 !== a(f, c) && b.push(f), f = J(e);
        return b;
      };
      function nf(a, b) {
        return a.Ga ? a.path.contains(b) : !!ua(a.children, function(c, d) {
          return a.path.u(d).contains(b);
        });
      }
      function pf(a) {
        return a.visible;
      }
      function of(a, b, c) {
        for (var d = df,
            e = 0; e < a.length; ++e) {
          var f = a[e];
          if (b(f)) {
            var h = f.path;
            if (f.Ga)
              c.contains(h) ? (h = T(c, h), d = ef(d, h, f.Ga)) : h.contains(c) && (h = T(h, c), d = ef(d, G, f.Ga.Q(h)));
            else if (f.children)
              if (c.contains(h))
                h = T(c, h), d = ff(d, h, f.children);
              else {
                if (h.contains(c))
                  if (h = T(h, c), h.e())
                    d = ff(d, G, f.children);
                  else if (f = w(f.children, E(h)))
                    f = f.Q(H(h)), d = ef(d, G, f);
              }
            else
              throw Fc("WriteRecord should have .snap or .children");
          }
        }
        return d;
      }
      function qf(a, b) {
        this.Mb = a;
        this.X = b;
      }
      g = qf.prototype;
      g.za = function(a, b, c) {
        return this.X.za(this.Mb, a, b, c);
      };
      g.yc = function(a) {
        return this.X.yc(this.Mb, a);
      };
      g.ld = function(a, b, c) {
        return this.X.ld(this.Mb, a, b, c);
      };
      g.tc = function(a) {
        return this.X.tc(this.Mb.u(a));
      };
      g.ne = function(a, b, c, d, e) {
        return this.X.ne(this.Mb, a, b, c, d, e);
      };
      g.xc = function(a, b) {
        return this.X.xc(this.Mb, a, b);
      };
      g.u = function(a) {
        return new qf(this.Mb.u(a), this.X);
      };
      function rf() {
        this.ya = {};
      }
      g = rf.prototype;
      g.e = function() {
        return wa(this.ya);
      };
      g.ab = function(a, b, c) {
        var d = a.source.Hb;
        if (null !== d)
          return d = w(this.ya, d), K(null != d, "SyncTree gave us an op for an invalid query."), d.ab(a, b, c);
        var e = [];
        r(this.ya, function(d) {
          e = e.concat(d.ab(a, b, c));
        });
        return e;
      };
      g.Pb = function(a, b, c, d, e) {
        var f = a.va(),
            h = w(this.ya, f);
        if (!h) {
          var h = c.za(e ? d : null),
              k = !1;
          h ? k = !0 : (h = d instanceof R ? c.yc(d) : C, k = !1);
          h = new ve(a, new Id(new tb(h, k, !1), new tb(d, e, !1)));
          this.ya[f] = h;
        }
        h.Pb(b);
        return ye(h, b);
      };
      g.jb = function(a, b, c) {
        var d = a.va(),
            e = [],
            f = [],
            h = null != sf(this);
        if ("default" === d) {
          var k = this;
          r(this.ya, function(a, d) {
            f = f.concat(a.jb(b, c));
            a.e() && (delete k.ya[d], S(a.W.n) || e.push(a.W));
          });
        } else {
          var l = w(this.ya, d);
          l && (f = f.concat(l.jb(b, c)), l.e() && (delete this.ya[d], S(l.W.n) || e.push(l.W)));
        }
        h && null == sf(this) && e.push(new U(a.k, a.path));
        return {
          Kg: e,
          mg: f
        };
      };
      function tf(a) {
        return Pa(ra(a.ya), function(a) {
          return !S(a.W.n);
        });
      }
      g.fb = function(a) {
        var b = null;
        r(this.ya, function(c) {
          b = b || c.fb(a);
        });
        return b;
      };
      function uf(a, b) {
        if (S(b.n))
          return sf(a);
        var c = b.va();
        return w(a.ya, c);
      }
      function sf(a) {
        return va(a.ya, function(a) {
          return S(a.W.n);
        }) || null;
      }
      ;
      function vf(a) {
        this.ta = Pd;
        this.ib = new lf;
        this.$e = {};
        this.mc = {};
        this.Nc = a;
      }
      function wf(a, b, c, d, e) {
        var f = a.ib,
            h = e;
        K(d > f.Mc, "Stacking an older write on top of newer ones");
        n(h) || (h = !0);
        f.na.push({
          path: b,
          Ga: c,
          kd: d,
          visible: h
        });
        h && (f.T = ef(f.T, b, c));
        f.Mc = d;
        return e ? xf(a, new Xb($e, b, c)) : [];
      }
      function yf(a, b, c, d) {
        var e = a.ib;
        K(d > e.Mc, "Stacking an older merge on top of newer ones");
        e.na.push({
          path: b,
          children: c,
          kd: d,
          visible: !0
        });
        e.T = ff(e.T, b, c);
        e.Mc = d;
        c = Oe(c);
        return xf(a, new ze($e, b, c));
      }
      function zf(a, b, c) {
        c = c || !1;
        var d = mf(a.ib, b);
        if (a.ib.Rd(b)) {
          var e = Pd;
          null != d.Ga ? e = e.set(G, !0) : ib(d.children, function(a, b) {
            e = e.set(new L(a), b);
          });
          return xf(a, new Ze(d.path, e, c));
        }
        return [];
      }
      function Af(a, b, c) {
        c = Oe(c);
        return xf(a, new ze(bf, b, c));
      }
      function Bf(a, b, c, d) {
        d = Cf(a, d);
        if (null != d) {
          var e = Df(d);
          d = e.path;
          e = e.Hb;
          b = T(d, b);
          c = new Xb(new af(!1, !0, e, !0), b, c);
          return Ef(a, d, c);
        }
        return [];
      }
      function Ff(a, b, c, d) {
        if (d = Cf(a, d)) {
          var e = Df(d);
          d = e.path;
          e = e.Hb;
          b = T(d, b);
          c = Oe(c);
          c = new ze(new af(!1, !0, e, !0), b, c);
          return Ef(a, d, c);
        }
        return [];
      }
      vf.prototype.Pb = function(a, b) {
        var c = a.path,
            d = null,
            e = !1;
        Ve(this.ta, c, function(a, b) {
          var f = T(a, c);
          d = d || b.fb(f);
          e = e || null != sf(b);
        });
        var f = this.ta.get(c);
        f ? (e = e || null != sf(f), d = d || f.fb(G)) : (f = new rf, this.ta = this.ta.set(c, f));
        var h;
        null != d ? h = !0 : (h = !1, d = C, Ye(this.ta.subtree(c), function(a, b) {
          var c = b.fb(G);
          c && (d = d.U(a, c));
        }));
        var k = null != uf(f, a);
        if (!k && !S(a.n)) {
          var l = Gf(a);
          K(!(l in this.mc), "View does not exist, but we have a tag");
          var m = Hf++;
          this.mc[l] = m;
          this.$e["_" + m] = l;
        }
        h = f.Pb(a, b, new qf(c, this.ib), d, h);
        k || e || (f = uf(f, a), h = h.concat(If(this, a, f)));
        return h;
      };
      vf.prototype.jb = function(a, b, c) {
        var d = a.path,
            e = this.ta.get(d),
            f = [];
        if (e && ("default" === a.va() || null != uf(e, a))) {
          f = e.jb(a, b, c);
          e.e() && (this.ta = this.ta.remove(d));
          e = f.Kg;
          f = f.mg;
          b = -1 !== Ua(e, function(a) {
            return S(a.n);
          });
          var h = Te(this.ta, d, function(a, b) {
            return null != sf(b);
          });
          if (b && !h && (d = this.ta.subtree(d), !d.e()))
            for (var d = Jf(d),
                k = 0; k < d.length; ++k) {
              var l = d[k],
                  m = l.W,
                  l = Kf(this, l);
              this.Nc.Xe(Lf(m), Mf(this, m), l.xd, l.H);
            }
          if (!h && 0 < e.length && !c)
            if (b)
              this.Nc.ae(Lf(a), null);
            else {
              var t = this;
              Oa(e, function(a) {
                a.va();
                var b = t.mc[Gf(a)];
                t.Nc.ae(Lf(a), b);
              });
            }
          Nf(this, e);
        }
        return f;
      };
      vf.prototype.za = function(a, b) {
        var c = this.ib,
            d = Te(this.ta, a, function(b, c) {
              var d = T(b, a);
              if (d = c.fb(d))
                return d;
            });
        return c.za(a, d, b, !0);
      };
      function Jf(a) {
        return Re(a, function(a, c, d) {
          if (c && null != sf(c))
            return [sf(c)];
          var e = [];
          c && (e = tf(c));
          r(d, function(a) {
            e = e.concat(a);
          });
          return e;
        });
      }
      function Nf(a, b) {
        for (var c = 0; c < b.length; ++c) {
          var d = b[c];
          if (!S(d.n)) {
            var d = Gf(d),
                e = a.mc[d];
            delete a.mc[d];
            delete a.$e["_" + e];
          }
        }
      }
      function Lf(a) {
        return S(a.n) && !fe(a.n) ? a.Ib() : a;
      }
      function If(a, b, c) {
        var d = b.path,
            e = Mf(a, b);
        c = Kf(a, c);
        b = a.Nc.Xe(Lf(b), e, c.xd, c.H);
        d = a.ta.subtree(d);
        if (e)
          K(null == sf(d.value), "If we're adding a query, it shouldn't be shadowed");
        else
          for (e = Re(d, function(a, b, c) {
            if (!a.e() && b && null != sf(b))
              return [we(sf(b))];
            var d = [];
            b && (d = d.concat(Qa(tf(b), function(a) {
              return a.W;
            })));
            r(c, function(a) {
              d = d.concat(a);
            });
            return d;
          }), d = 0; d < e.length; ++d)
            c = e[d], a.Nc.ae(Lf(c), Mf(a, c));
        return b;
      }
      function Kf(a, b) {
        var c = b.W,
            d = Mf(a, c);
        return {
          xd: function() {
            return (b.w() || C).hash();
          },
          H: function(b) {
            if ("ok" === b) {
              if (d) {
                var f = c.path;
                if (b = Cf(a, d)) {
                  var h = Df(b);
                  b = h.path;
                  h = h.Hb;
                  f = T(b, f);
                  f = new Zb(new af(!1, !0, h, !0), f);
                  b = Ef(a, b, f);
                } else
                  b = [];
              } else
                b = xf(a, new Zb(bf, c.path));
              return b;
            }
            f = "Unknown Error";
            "too_big" === b ? f = "The data requested exceeds the maximum size that can be accessed with a single request." : "permission_denied" == b ? f = "Client doesn't have permission to access the desired data." : "unavailable" == b && (f = "The service is unavailable");
            f = Error(b + ": " + f);
            f.code = b.toUpperCase();
            return a.jb(c, null, f);
          }
        };
      }
      function Gf(a) {
        return a.path.toString() + "$" + a.va();
      }
      function Df(a) {
        var b = a.indexOf("$");
        K(-1 !== b && b < a.length - 1, "Bad queryKey.");
        return {
          Hb: a.substr(b + 1),
          path: new L(a.substr(0, b))
        };
      }
      function Cf(a, b) {
        var c = a.$e,
            d = "_" + b;
        return d in c ? c[d] : void 0;
      }
      function Mf(a, b) {
        var c = Gf(b);
        return w(a.mc, c);
      }
      var Hf = 1;
      function Ef(a, b, c) {
        var d = a.ta.get(b);
        K(d, "Missing sync point for query tag that we're tracking");
        return d.ab(c, new qf(b, a.ib), null);
      }
      function xf(a, b) {
        return Of(a, b, a.ta, null, new qf(G, a.ib));
      }
      function Of(a, b, c, d, e) {
        if (b.path.e())
          return Pf(a, b, c, d, e);
        var f = c.get(G);
        null == d && null != f && (d = f.fb(G));
        var h = [],
            k = E(b.path),
            l = b.Xc(k);
        if ((c = c.children.get(k)) && l)
          var m = d ? d.R(k) : null,
              k = e.u(k),
              h = h.concat(Of(a, l, c, m, k));
        f && (h = h.concat(f.ab(b, e, d)));
        return h;
      }
      function Pf(a, b, c, d, e) {
        var f = c.get(G);
        null == d && null != f && (d = f.fb(G));
        var h = [];
        c.children.ia(function(c, f) {
          var m = d ? d.R(c) : null,
              t = e.u(c),
              z = b.Xc(c);
          z && (h = h.concat(Pf(a, z, f, m, t)));
        });
        f && (h = h.concat(f.ab(b, e, d)));
        return h;
      }
      ;
      function Qf() {
        this.children = {};
        this.nd = 0;
        this.value = null;
      }
      function Rf(a, b, c) {
        this.Gd = a ? a : "";
        this.Zc = b ? b : null;
        this.A = c ? c : new Qf;
      }
      function Sf(a, b) {
        for (var c = b instanceof L ? b : new L(b),
            d = a,
            e; null !== (e = E(c)); )
          d = new Rf(e, d, w(d.A.children, e) || new Qf), c = H(c);
        return d;
      }
      g = Rf.prototype;
      g.Ca = function() {
        return this.A.value;
      };
      function Tf(a, b) {
        K("undefined" !== typeof b, "Cannot set value to undefined");
        a.A.value = b;
        Uf(a);
      }
      g.clear = function() {
        this.A.value = null;
        this.A.children = {};
        this.A.nd = 0;
        Uf(this);
      };
      g.wd = function() {
        return 0 < this.A.nd;
      };
      g.e = function() {
        return null === this.Ca() && !this.wd();
      };
      g.P = function(a) {
        var b = this;
        r(this.A.children, function(c, d) {
          a(new Rf(d, b, c));
        });
      };
      function Vf(a, b, c, d) {
        c && !d && b(a);
        a.P(function(a) {
          Vf(a, b, !0, d);
        });
        c && d && b(a);
      }
      function Wf(a, b) {
        for (var c = a.parent(); null !== c && !b(c); )
          c = c.parent();
      }
      g.path = function() {
        return new L(null === this.Zc ? this.Gd : this.Zc.path() + "/" + this.Gd);
      };
      g.name = function() {
        return this.Gd;
      };
      g.parent = function() {
        return this.Zc;
      };
      function Uf(a) {
        if (null !== a.Zc) {
          var b = a.Zc,
              c = a.Gd,
              d = a.e(),
              e = v(b.A.children, c);
          d && e ? (delete b.A.children[c], b.A.nd--, Uf(b)) : d || e || (b.A.children[c] = a.A, b.A.nd++, Uf(b));
        }
      }
      ;
      var Xf = /[\[\].#$\/\u0000-\u001F\u007F]/,
          Yf = /[\[\].#$\u0000-\u001F\u007F]/,
          Zf = /^[a-zA-Z][a-zA-Z._\-+]+$/;
      function $f(a) {
        return p(a) && 0 !== a.length && !Xf.test(a);
      }
      function ag(a) {
        return null === a || p(a) || ga(a) && !Qc(a) || ia(a) && v(a, ".sv");
      }
      function bg(a, b, c, d) {
        d && !n(b) || cg(y(a, 1, d), b, c);
      }
      function cg(a, b, c) {
        c instanceof L && (c = new Je(c, a));
        if (!n(b))
          throw Error(a + "contains undefined " + Le(c));
        if (ha(b))
          throw Error(a + "contains a function " + Le(c) + " with contents: " + b.toString());
        if (Qc(b))
          throw Error(a + "contains " + b.toString() + " " + Le(c));
        if (p(b) && b.length > 10485760 / 3 && 10485760 < Zc(b))
          throw Error(a + "contains a string greater than 10485760 utf8 bytes " + Le(c) + " ('" + b.substring(0, 50) + "...')");
        if (ia(b)) {
          var d = !1,
              e = !1;
          ib(b, function(b, h) {
            if (".value" === b)
              d = !0;
            else if (".priority" !== b && ".sv" !== b && (e = !0, !$f(b)))
              throw Error(a + " contains an invalid key (" + b + ") " + Le(c) + '.  Keys must be non-empty strings and can\'t contain ".", "#", "$", "/", "[", or "]"');
            c.push(b);
            cg(a, h, c);
            c.pop();
          });
          if (d && e)
            throw Error(a + ' contains ".value" child ' + Le(c) + " in addition to actual children.");
        }
      }
      function dg(a, b) {
        var c,
            d;
        for (c = 0; c < b.length; c++) {
          d = b[c];
          for (var e = d.slice(),
              f = 0; f < e.length; f++)
            if ((".priority" !== e[f] || f !== e.length - 1) && !$f(e[f]))
              throw Error(a + "contains an invalid key (" + e[f] + ") in path " + d.toString() + '. Keys must be non-empty strings and can\'t contain ".", "#", "$", "/", "[", or "]"');
        }
        b.sort(Ie);
        e = null;
        for (c = 0; c < b.length; c++) {
          d = b[c];
          if (null !== e && e.contains(d))
            throw Error(a + "contains a path " + e.toString() + " that is ancestor of another path " + d.toString());
          e = d;
        }
      }
      function eg(a, b, c) {
        var d = y(a, 1, !1);
        if (!ia(b) || ea(b))
          throw Error(d + " must be an object containing the children to replace.");
        var e = [];
        ib(b, function(a, b) {
          var k = new L(a);
          cg(d, b, c.u(k));
          if (".priority" === Ld(k) && !ag(b))
            throw Error(d + "contains an invalid value for '" + k.toString() + "', which must be a valid Firebase priority (a string, finite number, server value, or null).");
          e.push(k);
        });
        dg(d, e);
      }
      function fg(a, b, c) {
        if (Qc(c))
          throw Error(y(a, b, !1) + "is " + c.toString() + ", but must be a valid Firebase priority (a string, finite number, server value, or null).");
        if (!ag(c))
          throw Error(y(a, b, !1) + "must be a valid Firebase priority (a string, finite number, server value, or null).");
      }
      function gg(a, b, c) {
        if (!c || n(b))
          switch (b) {
            case "value":
            case "child_added":
            case "child_removed":
            case "child_changed":
            case "child_moved":
              break;
            default:
              throw Error(y(a, 1, c) + 'must be a valid event type: "value", "child_added", "child_removed", "child_changed", or "child_moved".');
          }
      }
      function hg(a, b) {
        if (n(b) && !$f(b))
          throw Error(y(a, 2, !0) + 'was an invalid key: "' + b + '".  Firebase keys must be non-empty strings and can\'t contain ".", "#", "$", "/", "[", or "]").');
      }
      function ig(a, b) {
        if (!p(b) || 0 === b.length || Yf.test(b))
          throw Error(y(a, 1, !1) + 'was an invalid path: "' + b + '". Paths must be non-empty strings and can\'t contain ".", "#", "$", "[", or "]"');
      }
      function jg(a, b) {
        if (".info" === E(b))
          throw Error(a + " failed: Can't modify data under /.info/");
      }
      function kg(a, b) {
        if (!p(b))
          throw Error(y(a, 1, !1) + "must be a valid credential (a string).");
      }
      function lg(a, b, c) {
        if (!p(c))
          throw Error(y(a, b, !1) + "must be a valid string.");
      }
      function mg(a, b) {
        lg(a, 1, b);
        if (!Zf.test(b))
          throw Error(y(a, 1, !1) + "'" + b + "' is not a valid authentication provider.");
      }
      function ng(a, b, c, d) {
        if (!d || n(c))
          if (!ia(c) || null === c)
            throw Error(y(a, b, d) + "must be a valid object.");
      }
      function og(a, b, c) {
        if (!ia(b) || !v(b, c))
          throw Error(y(a, 1, !1) + 'must contain the key "' + c + '"');
        if (!p(w(b, c)))
          throw Error(y(a, 1, !1) + 'must contain the key "' + c + '" with type "string"');
      }
      ;
      function pg() {
        this.set = {};
      }
      g = pg.prototype;
      g.add = function(a, b) {
        this.set[a] = null !== b ? b : !0;
      };
      g.contains = function(a) {
        return v(this.set, a);
      };
      g.get = function(a) {
        return this.contains(a) ? this.set[a] : void 0;
      };
      g.remove = function(a) {
        delete this.set[a];
      };
      g.clear = function() {
        this.set = {};
      };
      g.e = function() {
        return wa(this.set);
      };
      g.count = function() {
        return pa(this.set);
      };
      function qg(a, b) {
        r(a.set, function(a, d) {
          b(d, a);
        });
      }
      g.keys = function() {
        var a = [];
        r(this.set, function(b, c) {
          a.push(c);
        });
        return a;
      };
      function qc() {
        this.m = this.B = null;
      }
      qc.prototype.find = function(a) {
        if (null != this.B)
          return this.B.Q(a);
        if (a.e() || null == this.m)
          return null;
        var b = E(a);
        a = H(a);
        return this.m.contains(b) ? this.m.get(b).find(a) : null;
      };
      qc.prototype.nc = function(a, b) {
        if (a.e())
          this.B = b, this.m = null;
        else if (null !== this.B)
          this.B = this.B.G(a, b);
        else {
          null == this.m && (this.m = new pg);
          var c = E(a);
          this.m.contains(c) || this.m.add(c, new qc);
          c = this.m.get(c);
          a = H(a);
          c.nc(a, b);
        }
      };
      function rg(a, b) {
        if (b.e())
          return a.B = null, a.m = null, !0;
        if (null !== a.B) {
          if (a.B.K())
            return !1;
          var c = a.B;
          a.B = null;
          c.P(N, function(b, c) {
            a.nc(new L(b), c);
          });
          return rg(a, b);
        }
        return null !== a.m ? (c = E(b), b = H(b), a.m.contains(c) && rg(a.m.get(c), b) && a.m.remove(c), a.m.e() ? (a.m = null, !0) : !1) : !0;
      }
      function rc(a, b, c) {
        null !== a.B ? c(b, a.B) : a.P(function(a, e) {
          var f = new L(b.toString() + "/" + a);
          rc(e, f, c);
        });
      }
      qc.prototype.P = function(a) {
        null !== this.m && qg(this.m, function(b, c) {
          a(b, c);
        });
      };
      var sg = "auth.firebase.com";
      function tg(a, b, c) {
        this.od = a || {};
        this.ee = b || {};
        this.$a = c || {};
        this.od.remember || (this.od.remember = "default");
      }
      var ug = ["remember", "redirectTo"];
      function vg(a) {
        var b = {},
            c = {};
        ib(a || {}, function(a, e) {
          0 <= Na(ug, a) ? b[a] = e : c[a] = e;
        });
        return new tg(b, {}, c);
      }
      ;
      function wg(a, b) {
        this.Qe = ["session", a.Od, a.hc].join(":");
        this.be = b;
      }
      wg.prototype.set = function(a, b) {
        if (!b)
          if (this.be.length)
            b = this.be[0];
          else
            throw Error("fb.login.SessionManager : No storage options available!");
        b.set(this.Qe, a);
      };
      wg.prototype.get = function() {
        var a = Qa(this.be, q(this.qg, this)),
            a = Pa(a, function(a) {
              return null !== a;
            });
        Xa(a, function(a, c) {
          return ad(c.token) - ad(a.token);
        });
        return 0 < a.length ? a.shift() : null;
      };
      wg.prototype.qg = function(a) {
        try {
          var b = a.get(this.Qe);
          if (b && b.token)
            return b;
        } catch (c) {}
        return null;
      };
      wg.prototype.clear = function() {
        var a = this;
        Oa(this.be, function(b) {
          b.remove(a.Qe);
        });
      };
      function xg() {
        return "undefined" !== typeof navigator && "string" === typeof navigator.userAgent ? navigator.userAgent : "";
      }
      function yg() {
        return "undefined" !== typeof window && !!(window.cordova || window.phonegap || window.PhoneGap) && /ios|iphone|ipod|ipad|android|blackberry|iemobile/i.test(xg());
      }
      function zg() {
        return "undefined" !== typeof location && /^file:\//.test(location.href);
      }
      function Ag(a) {
        var b = xg();
        if ("" === b)
          return !1;
        if ("Microsoft Internet Explorer" === navigator.appName) {
          if ((b = b.match(/MSIE ([0-9]{1,}[\.0-9]{0,})/)) && 1 < b.length)
            return parseFloat(b[1]) >= a;
        } else if (-1 < b.indexOf("Trident") && (b = b.match(/rv:([0-9]{2,2}[\.0-9]{0,})/)) && 1 < b.length)
          return parseFloat(b[1]) >= a;
        return !1;
      }
      ;
      function Bg() {
        var a = window.opener.frames,
            b;
        for (b = a.length - 1; 0 <= b; b--)
          try {
            if (a[b].location.protocol === window.location.protocol && a[b].location.host === window.location.host && "__winchan_relay_frame" === a[b].name)
              return a[b];
          } catch (c) {}
        return null;
      }
      function Cg(a, b, c) {
        a.attachEvent ? a.attachEvent("on" + b, c) : a.addEventListener && a.addEventListener(b, c, !1);
      }
      function Dg(a, b, c) {
        a.detachEvent ? a.detachEvent("on" + b, c) : a.removeEventListener && a.removeEventListener(b, c, !1);
      }
      function Eg(a) {
        /^https?:\/\//.test(a) || (a = window.location.href);
        var b = /^(https?:\/\/[\-_a-zA-Z\.0-9:]+)/.exec(a);
        return b ? b[1] : a;
      }
      function Fg(a) {
        var b = "";
        try {
          a = a.replace("#", "");
          var c = lb(a);
          c && v(c, "__firebase_request_key") && (b = w(c, "__firebase_request_key"));
        } catch (d) {}
        return b;
      }
      function Gg() {
        var a = Pc(sg);
        return a.scheme + "://" + a.host + "/v2";
      }
      function Hg(a) {
        return Gg() + "/" + a + "/auth/channel";
      }
      ;
      function Ig(a) {
        var b = this;
        this.Ac = a;
        this.ce = "*";
        Ag(8) ? this.Rc = this.zd = Bg() : (this.Rc = window.opener, this.zd = window);
        if (!b.Rc)
          throw "Unable to find relay frame";
        Cg(this.zd, "message", q(this.jc, this));
        Cg(this.zd, "message", q(this.Bf, this));
        try {
          Jg(this, {a: "ready"});
        } catch (c) {
          Cg(this.Rc, "load", function() {
            Jg(b, {a: "ready"});
          });
        }
        Cg(window, "unload", q(this.Bg, this));
      }
      function Jg(a, b) {
        b = B(b);
        Ag(8) ? a.Rc.doPost(b, a.ce) : a.Rc.postMessage(b, a.ce);
      }
      Ig.prototype.jc = function(a) {
        var b = this,
            c;
        try {
          c = nb(a.data);
        } catch (d) {}
        c && "request" === c.a && (Dg(window, "message", this.jc), this.ce = a.origin, this.Ac && setTimeout(function() {
          b.Ac(b.ce, c.d, function(a, c) {
            b.dg = !c;
            b.Ac = void 0;
            Jg(b, {
              a: "response",
              d: a,
              forceKeepWindowOpen: c
            });
          });
        }, 0));
      };
      Ig.prototype.Bg = function() {
        try {
          Dg(this.zd, "message", this.Bf);
        } catch (a) {}
        this.Ac && (Jg(this, {
          a: "error",
          d: "unknown closed window"
        }), this.Ac = void 0);
        try {
          window.close();
        } catch (b) {}
      };
      Ig.prototype.Bf = function(a) {
        if (this.dg && "die" === a.data)
          try {
            window.close();
          } catch (b) {}
      };
      function Kg(a) {
        this.pc = Ga() + Ga() + Ga();
        this.Ef = a;
      }
      Kg.prototype.open = function(a, b) {
        yc.set("redirect_request_id", this.pc);
        yc.set("redirect_request_id", this.pc);
        b.requestId = this.pc;
        b.redirectTo = b.redirectTo || window.location.href;
        a += (/\?/.test(a) ? "" : "?") + kb(b);
        window.location = a;
      };
      Kg.isAvailable = function() {
        return !zg() && !yg();
      };
      Kg.prototype.Cc = function() {
        return "redirect";
      };
      var Lg = {
        NETWORK_ERROR: "Unable to contact the Firebase server.",
        SERVER_ERROR: "An unknown server error occurred.",
        TRANSPORT_UNAVAILABLE: "There are no login transports available for the requested method.",
        REQUEST_INTERRUPTED: "The browser redirected the page before the login request could complete.",
        USER_CANCELLED: "The user cancelled authentication."
      };
      function Mg(a) {
        var b = Error(w(Lg, a), a);
        b.code = a;
        return b;
      }
      ;
      function Ng(a) {
        var b;
        (b = !a.window_features) || (b = xg(), b = -1 !== b.indexOf("Fennec/") || -1 !== b.indexOf("Firefox/") && -1 !== b.indexOf("Android"));
        b && (a.window_features = void 0);
        a.window_name || (a.window_name = "_blank");
        this.options = a;
      }
      Ng.prototype.open = function(a, b, c) {
        function d(a) {
          h && (document.body.removeChild(h), h = void 0);
          t && (t = clearInterval(t));
          Dg(window, "message", e);
          Dg(window, "unload", d);
          if (m && !a)
            try {
              m.close();
            } catch (b) {
              k.postMessage("die", l);
            }
          m = k = void 0;
        }
        function e(a) {
          if (a.origin === l)
            try {
              var b = nb(a.data);
              "ready" === b.a ? k.postMessage(z, l) : "error" === b.a ? (d(!1), c && (c(b.d), c = null)) : "response" === b.a && (d(b.forceKeepWindowOpen), c && (c(null, b.d), c = null));
            } catch (e) {}
        }
        var f = Ag(8),
            h,
            k;
        if (!this.options.relay_url)
          return c(Error("invalid arguments: origin of url and relay_url must match"));
        var l = Eg(a);
        if (l !== Eg(this.options.relay_url))
          c && setTimeout(function() {
            c(Error("invalid arguments: origin of url and relay_url must match"));
          }, 0);
        else {
          f && (h = document.createElement("iframe"), h.setAttribute("src", this.options.relay_url), h.style.display = "none", h.setAttribute("name", "__winchan_relay_frame"), document.body.appendChild(h), k = h.contentWindow);
          a += (/\?/.test(a) ? "" : "?") + kb(b);
          var m = window.open(a, this.options.window_name, this.options.window_features);
          k || (k = m);
          var t = setInterval(function() {
            m && m.closed && (d(!1), c && (c(Mg("USER_CANCELLED")), c = null));
          }, 500),
              z = B({
                a: "request",
                d: b
              });
          Cg(window, "unload", d);
          Cg(window, "message", e);
        }
      };
      Ng.isAvailable = function() {
        var a;
        if (a = "postMessage" in window && !zg())
          (a = yg() || "undefined" !== typeof navigator && (!!xg().match(/Windows Phone/) || !!window.Windows && /^ms-appx:/.test(location.href))) || (a = xg(), a = "undefined" !== typeof navigator && "undefined" !== typeof window && !!(a.match(/(iPhone|iPod|iPad).*AppleWebKit(?!.*Safari)/i) || a.match(/CriOS/) || a.match(/Twitter for iPhone/) || a.match(/FBAN\/FBIOS/) || window.navigator.standalone)), a = !a;
        return a && !xg().match(/PhantomJS/);
      };
      Ng.prototype.Cc = function() {
        return "popup";
      };
      function Og(a) {
        a.method || (a.method = "GET");
        a.headers || (a.headers = {});
        a.headers.content_type || (a.headers.content_type = "application/json");
        a.headers.content_type = a.headers.content_type.toLowerCase();
        this.options = a;
      }
      Og.prototype.open = function(a, b, c) {
        function d() {
          c && (c(Mg("REQUEST_INTERRUPTED")), c = null);
        }
        var e = new XMLHttpRequest,
            f = this.options.method.toUpperCase(),
            h;
        Cg(window, "beforeunload", d);
        e.onreadystatechange = function() {
          if (c && 4 === e.readyState) {
            var a;
            if (200 <= e.status && 300 > e.status) {
              try {
                a = nb(e.responseText);
              } catch (b) {}
              c(null, a);
            } else
              500 <= e.status && 600 > e.status ? c(Mg("SERVER_ERROR")) : c(Mg("NETWORK_ERROR"));
            c = null;
            Dg(window, "beforeunload", d);
          }
        };
        if ("GET" === f)
          a += (/\?/.test(a) ? "" : "?") + kb(b), h = null;
        else {
          var k = this.options.headers.content_type;
          "application/json" === k && (h = B(b));
          "application/x-www-form-urlencoded" === k && (h = kb(b));
        }
        e.open(f, a, !0);
        a = {
          "X-Requested-With": "XMLHttpRequest",
          Accept: "application/json;text/plain"
        };
        za(a, this.options.headers);
        for (var l in a)
          e.setRequestHeader(l, a[l]);
        e.send(h);
      };
      Og.isAvailable = function() {
        var a;
        if (a = !!window.XMLHttpRequest)
          a = xg(), a = !(a.match(/MSIE/) || a.match(/Trident/)) || Ag(10);
        return a;
      };
      Og.prototype.Cc = function() {
        return "json";
      };
      function Pg(a) {
        this.pc = Ga() + Ga() + Ga();
        this.Ef = a;
      }
      Pg.prototype.open = function(a, b, c) {
        function d() {
          c && (c(Mg("USER_CANCELLED")), c = null);
        }
        var e = this,
            f = Pc(sg),
            h;
        b.requestId = this.pc;
        b.redirectTo = f.scheme + "://" + f.host + "/blank/page.html";
        a += /\?/.test(a) ? "" : "?";
        a += kb(b);
        (h = window.open(a, "_blank", "location=no")) && ha(h.addEventListener) ? (h.addEventListener("loadstart", function(a) {
          var b;
          if (b = a && a.url)
            a: {
              try {
                var m = document.createElement("a");
                m.href = a.url;
                b = m.host === f.host && "/blank/page.html" === m.pathname;
                break a;
              } catch (t) {}
              b = !1;
            }
          b && (a = Fg(a.url), h.removeEventListener("exit", d), h.close(), a = new tg(null, null, {
            requestId: e.pc,
            requestKey: a
          }), e.Ef.requestWithCredential("/auth/session", a, c), c = null);
        }), h.addEventListener("exit", d)) : c(Mg("TRANSPORT_UNAVAILABLE"));
      };
      Pg.isAvailable = function() {
        return yg();
      };
      Pg.prototype.Cc = function() {
        return "redirect";
      };
      function Qg(a) {
        a.callback_parameter || (a.callback_parameter = "callback");
        this.options = a;
        window.__firebase_auth_jsonp = window.__firebase_auth_jsonp || {};
      }
      Qg.prototype.open = function(a, b, c) {
        function d() {
          c && (c(Mg("REQUEST_INTERRUPTED")), c = null);
        }
        function e() {
          setTimeout(function() {
            window.__firebase_auth_jsonp[f] = void 0;
            wa(window.__firebase_auth_jsonp) && (window.__firebase_auth_jsonp = void 0);
            try {
              var a = document.getElementById(f);
              a && a.parentNode.removeChild(a);
            } catch (b) {}
          }, 1);
          Dg(window, "beforeunload", d);
        }
        var f = "fn" + (new Date).getTime() + Math.floor(99999 * Math.random());
        b[this.options.callback_parameter] = "__firebase_auth_jsonp." + f;
        a += (/\?/.test(a) ? "" : "?") + kb(b);
        Cg(window, "beforeunload", d);
        window.__firebase_auth_jsonp[f] = function(a) {
          c && (c(null, a), c = null);
          e();
        };
        Rg(f, a, c);
      };
      function Rg(a, b, c) {
        setTimeout(function() {
          try {
            var d = document.createElement("script");
            d.type = "text/javascript";
            d.id = a;
            d.async = !0;
            d.src = b;
            d.onerror = function() {
              var b = document.getElementById(a);
              null !== b && b.parentNode.removeChild(b);
              c && c(Mg("NETWORK_ERROR"));
            };
            var e = document.getElementsByTagName("head");
            (e && 0 != e.length ? e[0] : document.documentElement).appendChild(d);
          } catch (f) {
            c && c(Mg("NETWORK_ERROR"));
          }
        }, 0);
      }
      Qg.isAvailable = function() {
        return "undefined" !== typeof document && null != document.createElement;
      };
      Qg.prototype.Cc = function() {
        return "json";
      };
      function Sg(a, b, c, d) {
        De.call(this, ["auth_status"]);
        this.F = a;
        this.df = b;
        this.Vg = c;
        this.Le = d;
        this.sc = new wg(a, [xc, yc]);
        this.mb = null;
        this.Se = !1;
        Tg(this);
      }
      ma(Sg, De);
      g = Sg.prototype;
      g.xe = function() {
        return this.mb || null;
      };
      function Tg(a) {
        yc.get("redirect_request_id") && Ug(a);
        var b = a.sc.get();
        b && b.token ? (Vg(a, b), a.df(b.token, function(c, d) {
          Wg(a, c, d, !1, b.token, b);
        }, function(b, d) {
          Xg(a, "resumeSession()", b, d);
        })) : Vg(a, null);
      }
      function Yg(a, b, c, d, e, f) {
        "firebaseio-demo.com" === a.F.domain && O("Firebase authentication is not supported on demo Firebases (*.firebaseio-demo.com). To secure your Firebase, create a production Firebase at https://www.firebase.com.");
        a.df(b, function(f, k) {
          Wg(a, f, k, !0, b, c, d || {}, e);
        }, function(b, c) {
          Xg(a, "auth()", b, c, f);
        });
      }
      function Zg(a, b) {
        a.sc.clear();
        Vg(a, null);
        a.Vg(function(a, d) {
          if ("ok" === a)
            P(b, null);
          else {
            var e = (a || "error").toUpperCase(),
                f = e;
            d && (f += ": " + d);
            f = Error(f);
            f.code = e;
            P(b, f);
          }
        });
      }
      function Wg(a, b, c, d, e, f, h, k) {
        "ok" === b ? (d && (b = c.auth, f.auth = b, f.expires = c.expires, f.token = bd(e) ? e : "", c = null, b && v(b, "uid") ? c = w(b, "uid") : v(f, "uid") && (c = w(f, "uid")), f.uid = c, c = "custom", b && v(b, "provider") ? c = w(b, "provider") : v(f, "provider") && (c = w(f, "provider")), f.provider = c, a.sc.clear(), bd(e) && (h = h || {}, c = xc, "sessionOnly" === h.remember && (c = yc), "none" !== h.remember && a.sc.set(f, c)), Vg(a, f)), P(k, null, f)) : (a.sc.clear(), Vg(a, null), f = a = (b || "error").toUpperCase(), c && (f += ": " + c), f = Error(f), f.code = a, P(k, f));
      }
      function Xg(a, b, c, d, e) {
        O(b + " was canceled: " + d);
        a.sc.clear();
        Vg(a, null);
        a = Error(d);
        a.code = c.toUpperCase();
        P(e, a);
      }
      function $g(a, b, c, d, e) {
        ah(a);
        c = new tg(d || {}, {}, c || {});
        bh(a, [Og, Qg], "/auth/" + b, c, e);
      }
      function ch(a, b, c, d) {
        ah(a);
        var e = [Ng, Pg];
        c = vg(c);
        "anonymous" === b || "password" === b ? setTimeout(function() {
          P(d, Mg("TRANSPORT_UNAVAILABLE"));
        }, 0) : (c.ee.window_features = "menubar=yes,modal=yes,alwaysRaised=yeslocation=yes,resizable=yes,scrollbars=yes,status=yes,height=625,width=625,top=" + ("object" === typeof screen ? .5 * (screen.height - 625) : 0) + ",left=" + ("object" === typeof screen ? .5 * (screen.width - 625) : 0), c.ee.relay_url = Hg(a.F.hc), c.ee.requestWithCredential = q(a.qc, a), bh(a, e, "/auth/" + b, c, d));
      }
      function Ug(a) {
        var b = yc.get("redirect_request_id");
        if (b) {
          var c = yc.get("redirect_client_options");
          yc.remove("redirect_request_id");
          yc.remove("redirect_client_options");
          var d = [Og, Qg],
              b = {
                requestId: b,
                requestKey: Fg(document.location.hash)
              },
              c = new tg(c, {}, b);
          a.Se = !0;
          try {
            document.location.hash = document.location.hash.replace(/&__firebase_request_key=([a-zA-z0-9]*)/, "");
          } catch (e) {}
          bh(a, d, "/auth/session", c, function() {
            this.Se = !1;
          }.bind(a));
        }
      }
      g.se = function(a, b) {
        ah(this);
        var c = vg(a);
        c.$a._method = "POST";
        this.qc("/users", c, function(a, c) {
          a ? P(b, a) : P(b, a, c);
        });
      };
      g.Te = function(a, b) {
        var c = this;
        ah(this);
        var d = "/users/" + encodeURIComponent(a.email),
            e = vg(a);
        e.$a._method = "DELETE";
        this.qc(d, e, function(a, d) {
          !a && d && d.uid && c.mb && c.mb.uid && c.mb.uid === d.uid && Zg(c);
          P(b, a);
        });
      };
      g.pe = function(a, b) {
        ah(this);
        var c = "/users/" + encodeURIComponent(a.email) + "/password",
            d = vg(a);
        d.$a._method = "PUT";
        d.$a.password = a.newPassword;
        this.qc(c, d, function(a) {
          P(b, a);
        });
      };
      g.oe = function(a, b) {
        ah(this);
        var c = "/users/" + encodeURIComponent(a.oldEmail) + "/email",
            d = vg(a);
        d.$a._method = "PUT";
        d.$a.email = a.newEmail;
        d.$a.password = a.password;
        this.qc(c, d, function(a) {
          P(b, a);
        });
      };
      g.Ve = function(a, b) {
        ah(this);
        var c = "/users/" + encodeURIComponent(a.email) + "/password",
            d = vg(a);
        d.$a._method = "POST";
        this.qc(c, d, function(a) {
          P(b, a);
        });
      };
      g.qc = function(a, b, c) {
        dh(this, [Og, Qg], a, b, c);
      };
      function bh(a, b, c, d, e) {
        dh(a, b, c, d, function(b, c) {
          !b && c && c.token && c.uid ? Yg(a, c.token, c, d.od, function(a, b) {
            a ? P(e, a) : P(e, null, b);
          }) : P(e, b || Mg("UNKNOWN_ERROR"));
        });
      }
      function dh(a, b, c, d, e) {
        b = Pa(b, function(a) {
          return "function" === typeof a.isAvailable && a.isAvailable();
        });
        0 === b.length ? setTimeout(function() {
          P(e, Mg("TRANSPORT_UNAVAILABLE"));
        }, 0) : (b = new (b.shift())(d.ee), d = jb(d.$a), d.v = "js-" + hb, d.transport = b.Cc(), d.suppress_status_codes = !0, a = Gg() + "/" + a.F.hc + c, b.open(a, d, function(a, b) {
          if (a)
            P(e, a);
          else if (b && b.error) {
            var c = Error(b.error.message);
            c.code = b.error.code;
            c.details = b.error.details;
            P(e, c);
          } else
            P(e, null, b);
        }));
      }
      function Vg(a, b) {
        var c = null !== a.mb || null !== b;
        a.mb = b;
        c && a.fe("auth_status", b);
        a.Le(null !== b);
      }
      g.Ae = function(a) {
        K("auth_status" === a, 'initial event must be of type "auth_status"');
        return this.Se ? null : [this.mb];
      };
      function ah(a) {
        var b = a.F;
        if ("firebaseio.com" !== b.domain && "firebaseio-demo.com" !== b.domain && "auth.firebase.com" === sg)
          throw Error("This custom Firebase server ('" + a.F.domain + "') does not support delegated login.");
      }
      ;
      var Cc = "websocket",
          Dc = "long_polling";
      function eh(a) {
        this.jc = a;
        this.Nd = [];
        this.Sb = 0;
        this.qe = -1;
        this.Fb = null;
      }
      function fh(a, b, c) {
        a.qe = b;
        a.Fb = c;
        a.qe < a.Sb && (a.Fb(), a.Fb = null);
      }
      function gh(a, b, c) {
        for (a.Nd[b] = c; a.Nd[a.Sb]; ) {
          var d = a.Nd[a.Sb];
          delete a.Nd[a.Sb];
          for (var e = 0; e < d.length; ++e)
            if (d[e]) {
              var f = a;
              Db(function() {
                f.jc(d[e]);
              });
            }
          if (a.Sb === a.qe) {
            a.Fb && (clearTimeout(a.Fb), a.Fb(), a.Fb = null);
            break;
          }
          a.Sb++;
        }
      }
      ;
      function hh(a, b, c, d) {
        this.re = a;
        this.f = Mc(a);
        this.nb = this.ob = 0;
        this.Ua = Rb(b);
        this.Qf = c;
        this.Hc = !1;
        this.Bb = d;
        this.jd = function(a) {
          return Bc(b, Dc, a);
        };
      }
      var ih,
          jh;
      hh.prototype.open = function(a, b) {
        this.hf = 0;
        this.la = b;
        this.Af = new eh(a);
        this.zb = !1;
        var c = this;
        this.qb = setTimeout(function() {
          c.f("Timed out trying to connect.");
          c.gb();
          c.qb = null;
        }, Math.floor(3E4));
        Rc(function() {
          if (!c.zb) {
            c.Sa = new kh(function(a, b, d, k, l) {
              lh(c, arguments);
              if (c.Sa)
                if (c.qb && (clearTimeout(c.qb), c.qb = null), c.Hc = !0, "start" == a)
                  c.id = b, c.Gf = d;
                else if ("close" === a)
                  b ? (c.Sa.Xd = !1, fh(c.Af, b, function() {
                    c.gb();
                  })) : c.gb();
                else
                  throw Error("Unrecognized command received: " + a);
            }, function(a, b) {
              lh(c, arguments);
              gh(c.Af, a, b);
            }, function() {
              c.gb();
            }, c.jd);
            var a = {start: "t"};
            a.ser = Math.floor(1E8 * Math.random());
            c.Sa.he && (a.cb = c.Sa.he);
            a.v = "5";
            c.Qf && (a.s = c.Qf);
            c.Bb && (a.ls = c.Bb);
            "undefined" !== typeof location && location.href && -1 !== location.href.indexOf("firebaseio.com") && (a.r = "f");
            a = c.jd(a);
            c.f("Connecting via long-poll to " + a);
            mh(c.Sa, a, function() {});
          }
        });
      };
      hh.prototype.start = function() {
        var a = this.Sa,
            b = this.Gf;
        a.ug = this.id;
        a.vg = b;
        for (a.le = !0; nh(a); )
          ;
        a = this.id;
        b = this.Gf;
        this.gc = document.createElement("iframe");
        var c = {dframe: "t"};
        c.id = a;
        c.pw = b;
        this.gc.src = this.jd(c);
        this.gc.style.display = "none";
        document.body.appendChild(this.gc);
      };
      hh.isAvailable = function() {
        return ih || !jh && "undefined" !== typeof document && null != document.createElement && !("object" === typeof window && window.chrome && window.chrome.extension && !/^chrome/.test(window.location.href)) && !("object" === typeof Windows && "object" === typeof Windows.Xg) && !0;
      };
      g = hh.prototype;
      g.Ed = function() {};
      g.dd = function() {
        this.zb = !0;
        this.Sa && (this.Sa.close(), this.Sa = null);
        this.gc && (document.body.removeChild(this.gc), this.gc = null);
        this.qb && (clearTimeout(this.qb), this.qb = null);
      };
      g.gb = function() {
        this.zb || (this.f("Longpoll is closing itself"), this.dd(), this.la && (this.la(this.Hc), this.la = null));
      };
      g.close = function() {
        this.zb || (this.f("Longpoll is being closed."), this.dd());
      };
      g.send = function(a) {
        a = B(a);
        this.ob += a.length;
        Ob(this.Ua, "bytes_sent", a.length);
        a = Ic(a);
        a = fb(a, !0);
        a = Vc(a, 1840);
        for (var b = 0; b < a.length; b++) {
          var c = this.Sa;
          c.ad.push({
            Mg: this.hf,
            Ug: a.length,
            kf: a[b]
          });
          c.le && nh(c);
          this.hf++;
        }
      };
      function lh(a, b) {
        var c = B(b).length;
        a.nb += c;
        Ob(a.Ua, "bytes_received", c);
      }
      function kh(a, b, c, d) {
        this.jd = d;
        this.hb = c;
        this.Pe = new pg;
        this.ad = [];
        this.te = Math.floor(1E8 * Math.random());
        this.Xd = !0;
        this.he = Ec();
        window["pLPCommand" + this.he] = a;
        window["pRTLPCB" + this.he] = b;
        a = document.createElement("iframe");
        a.style.display = "none";
        if (document.body) {
          document.body.appendChild(a);
          try {
            a.contentWindow.document || Cb("No IE domain setting required");
          } catch (e) {
            a.src = "javascript:void((function(){document.open();document.domain='" + document.domain + "';document.close();})())";
          }
        } else
          throw "Document body has not initialized. Wait to initialize Firebase until after the document is ready.";
        a.contentDocument ? a.eb = a.contentDocument : a.contentWindow ? a.eb = a.contentWindow.document : a.document && (a.eb = a.document);
        this.Ea = a;
        a = "";
        this.Ea.src && "javascript:" === this.Ea.src.substr(0, 11) && (a = '<script>document.domain="' + document.domain + '";\x3c/script>');
        a = "<html><body>" + a + "</body></html>";
        try {
          this.Ea.eb.open(), this.Ea.eb.write(a), this.Ea.eb.close();
        } catch (f) {
          Cb("frame writing exception"), f.stack && Cb(f.stack), Cb(f);
        }
      }
      kh.prototype.close = function() {
        this.le = !1;
        if (this.Ea) {
          this.Ea.eb.body.innerHTML = "";
          var a = this;
          setTimeout(function() {
            null !== a.Ea && (document.body.removeChild(a.Ea), a.Ea = null);
          }, Math.floor(0));
        }
        var b = this.hb;
        b && (this.hb = null, b());
      };
      function nh(a) {
        if (a.le && a.Xd && a.Pe.count() < (0 < a.ad.length ? 2 : 1)) {
          a.te++;
          var b = {};
          b.id = a.ug;
          b.pw = a.vg;
          b.ser = a.te;
          for (var b = a.jd(b),
              c = "",
              d = 0; 0 < a.ad.length; )
            if (1870 >= a.ad[0].kf.length + 30 + c.length) {
              var e = a.ad.shift(),
                  c = c + "&seg" + d + "=" + e.Mg + "&ts" + d + "=" + e.Ug + "&d" + d + "=" + e.kf;
              d++;
            } else
              break;
          oh(a, b + c, a.te);
          return !0;
        }
        return !1;
      }
      function oh(a, b, c) {
        function d() {
          a.Pe.remove(c);
          nh(a);
        }
        a.Pe.add(c, 1);
        var e = setTimeout(d, Math.floor(25E3));
        mh(a, b, function() {
          clearTimeout(e);
          d();
        });
      }
      function mh(a, b, c) {
        setTimeout(function() {
          try {
            if (a.Xd) {
              var d = a.Ea.eb.createElement("script");
              d.type = "text/javascript";
              d.async = !0;
              d.src = b;
              d.onload = d.onreadystatechange = function() {
                var a = d.readyState;
                a && "loaded" !== a && "complete" !== a || (d.onload = d.onreadystatechange = null, d.parentNode && d.parentNode.removeChild(d), c());
              };
              d.onerror = function() {
                Cb("Long-poll script failed to load: " + b);
                a.Xd = !1;
                a.close();
              };
              a.Ea.eb.body.appendChild(d);
            }
          } catch (e) {}
        }, Math.floor(1));
      }
      ;
      var ph = null;
      "undefined" !== typeof MozWebSocket ? ph = MozWebSocket : "undefined" !== typeof WebSocket && (ph = WebSocket);
      function qh(a, b, c, d) {
        this.re = a;
        this.f = Mc(this.re);
        this.frames = this.Kc = null;
        this.nb = this.ob = this.bf = 0;
        this.Ua = Rb(b);
        a = {v: "5"};
        "undefined" !== typeof location && location.href && -1 !== location.href.indexOf("firebaseio.com") && (a.r = "f");
        c && (a.s = c);
        d && (a.ls = d);
        this.ef = Bc(b, Cc, a);
      }
      var rh;
      qh.prototype.open = function(a, b) {
        this.hb = b;
        this.zg = a;
        this.f("Websocket connecting to " + this.ef);
        this.Hc = !1;
        xc.set("previous_websocket_failure", !0);
        try {
          this.ua = new ph(this.ef);
        } catch (c) {
          this.f("Error instantiating WebSocket.");
          var d = c.message || c.data;
          d && this.f(d);
          this.gb();
          return;
        }
        var e = this;
        this.ua.onopen = function() {
          e.f("Websocket connected.");
          e.Hc = !0;
        };
        this.ua.onclose = function() {
          e.f("Websocket connection was disconnected.");
          e.ua = null;
          e.gb();
        };
        this.ua.onmessage = function(a) {
          if (null !== e.ua)
            if (a = a.data, e.nb += a.length, Ob(e.Ua, "bytes_received", a.length), sh(e), null !== e.frames)
              th(e, a);
            else {
              a: {
                K(null === e.frames, "We already have a frame buffer");
                if (6 >= a.length) {
                  var b = Number(a);
                  if (!isNaN(b)) {
                    e.bf = b;
                    e.frames = [];
                    a = null;
                    break a;
                  }
                }
                e.bf = 1;
                e.frames = [];
              }
              null !== a && th(e, a);
            }
        };
        this.ua.onerror = function(a) {
          e.f("WebSocket error.  Closing connection.");
          (a = a.message || a.data) && e.f(a);
          e.gb();
        };
      };
      qh.prototype.start = function() {};
      qh.isAvailable = function() {
        var a = !1;
        if ("undefined" !== typeof navigator && navigator.userAgent) {
          var b = navigator.userAgent.match(/Android ([0-9]{0,}\.[0-9]{0,})/);
          b && 1 < b.length && 4.4 > parseFloat(b[1]) && (a = !0);
        }
        return !a && null !== ph && !rh;
      };
      qh.responsesRequiredToBeHealthy = 2;
      qh.healthyTimeout = 3E4;
      g = qh.prototype;
      g.Ed = function() {
        xc.remove("previous_websocket_failure");
      };
      function th(a, b) {
        a.frames.push(b);
        if (a.frames.length == a.bf) {
          var c = a.frames.join("");
          a.frames = null;
          c = nb(c);
          a.zg(c);
        }
      }
      g.send = function(a) {
        sh(this);
        a = B(a);
        this.ob += a.length;
        Ob(this.Ua, "bytes_sent", a.length);
        a = Vc(a, 16384);
        1 < a.length && this.ua.send(String(a.length));
        for (var b = 0; b < a.length; b++)
          this.ua.send(a[b]);
      };
      g.dd = function() {
        this.zb = !0;
        this.Kc && (clearInterval(this.Kc), this.Kc = null);
        this.ua && (this.ua.close(), this.ua = null);
      };
      g.gb = function() {
        this.zb || (this.f("WebSocket is closing itself"), this.dd(), this.hb && (this.hb(this.Hc), this.hb = null));
      };
      g.close = function() {
        this.zb || (this.f("WebSocket is being closed"), this.dd());
      };
      function sh(a) {
        clearInterval(a.Kc);
        a.Kc = setInterval(function() {
          a.ua && a.ua.send("0");
          sh(a);
        }, Math.floor(45E3));
      }
      ;
      function uh(a) {
        vh(this, a);
      }
      var wh = [hh, qh];
      function vh(a, b) {
        var c = qh && qh.isAvailable(),
            d = c && !(xc.wf || !0 === xc.get("previous_websocket_failure"));
        b.Wg && (c || O("wss:// URL used, but browser isn't known to support websockets.  Trying anyway."), d = !0);
        if (d)
          a.gd = [qh];
        else {
          var e = a.gd = [];
          Wc(wh, function(a, b) {
            b && b.isAvailable() && e.push(b);
          });
        }
      }
      function xh(a) {
        if (0 < a.gd.length)
          return a.gd[0];
        throw Error("No transports available");
      }
      ;
      function yh(a, b, c, d, e, f, h) {
        this.id = a;
        this.f = Mc("c:" + this.id + ":");
        this.jc = c;
        this.Wc = d;
        this.la = e;
        this.Ne = f;
        this.F = b;
        this.Md = [];
        this.ff = 0;
        this.Pf = new uh(b);
        this.Ta = 0;
        this.Bb = h;
        this.f("Connection created");
        zh(this);
      }
      function zh(a) {
        var b = xh(a.Pf);
        a.J = new b("c:" + a.id + ":" + a.ff++, a.F, void 0, a.Bb);
        a.Re = b.responsesRequiredToBeHealthy || 0;
        var c = Ah(a, a.J),
            d = Bh(a, a.J);
        a.hd = a.J;
        a.cd = a.J;
        a.D = null;
        a.Ab = !1;
        setTimeout(function() {
          a.J && a.J.open(c, d);
        }, Math.floor(0));
        b = b.healthyTimeout || 0;
        0 < b && (a.yd = setTimeout(function() {
          a.yd = null;
          a.Ab || (a.J && 102400 < a.J.nb ? (a.f("Connection exceeded healthy timeout but has received " + a.J.nb + " bytes.  Marking connection healthy."), a.Ab = !0, a.J.Ed()) : a.J && 10240 < a.J.ob ? a.f("Connection exceeded healthy timeout but has sent " + a.J.ob + " bytes.  Leaving connection alive.") : (a.f("Closing unhealthy connection after timeout."), a.close()));
        }, Math.floor(b)));
      }
      function Bh(a, b) {
        return function(c) {
          b === a.J ? (a.J = null, c || 0 !== a.Ta ? 1 === a.Ta && a.f("Realtime connection lost.") : (a.f("Realtime connection failed."), "s-" === a.F.Ya.substr(0, 2) && (xc.remove("host:" + a.F.host), a.F.Ya = a.F.host)), a.close()) : b === a.D ? (a.f("Secondary connection lost."), c = a.D, a.D = null, a.hd !== c && a.cd !== c || a.close()) : a.f("closing an old connection");
        };
      }
      function Ah(a, b) {
        return function(c) {
          if (2 != a.Ta)
            if (b === a.cd) {
              var d = Tc("t", c);
              c = Tc("d", c);
              if ("c" == d) {
                if (d = Tc("t", c), "d" in c)
                  if (c = c.d, "h" === d) {
                    var d = c.ts,
                        e = c.v,
                        f = c.h;
                    a.Nf = c.s;
                    Ac(a.F, f);
                    0 == a.Ta && (a.J.start(), Ch(a, a.J, d), "5" !== e && O("Protocol version mismatch detected"), c = a.Pf, (c = 1 < c.gd.length ? c.gd[1] : null) && Dh(a, c));
                  } else if ("n" === d) {
                    a.f("recvd end transmission on primary");
                    a.cd = a.D;
                    for (c = 0; c < a.Md.length; ++c)
                      a.Id(a.Md[c]);
                    a.Md = [];
                    Eh(a);
                  } else
                    "s" === d ? (a.f("Connection shutdown command received. Shutting down..."), a.Ne && (a.Ne(c), a.Ne = null), a.la = null, a.close()) : "r" === d ? (a.f("Reset packet received.  New host: " + c), Ac(a.F, c), 1 === a.Ta ? a.close() : (Fh(a), zh(a))) : "e" === d ? Nc("Server Error: " + c) : "o" === d ? (a.f("got pong on primary."), Gh(a), Hh(a)) : Nc("Unknown control packet command: " + d);
              } else
                "d" == d && a.Id(c);
            } else if (b === a.D)
              if (d = Tc("t", c), c = Tc("d", c), "c" == d)
                "t" in c && (c = c.t, "a" === c ? Ih(a) : "r" === c ? (a.f("Got a reset on secondary, closing it"), a.D.close(), a.hd !== a.D && a.cd !== a.D || a.close()) : "o" === c && (a.f("got pong on secondary."), a.Mf--, Ih(a)));
              else if ("d" == d)
                a.Md.push(c);
              else
                throw Error("Unknown protocol layer: " + d);
            else
              a.f("message on old connection");
        };
      }
      yh.prototype.Fa = function(a) {
        Jh(this, {
          t: "d",
          d: a
        });
      };
      function Eh(a) {
        a.hd === a.D && a.cd === a.D && (a.f("cleaning up and promoting a connection: " + a.D.re), a.J = a.D, a.D = null);
      }
      function Ih(a) {
        0 >= a.Mf ? (a.f("Secondary connection is healthy."), a.Ab = !0, a.D.Ed(), a.D.start(), a.f("sending client ack on secondary"), a.D.send({
          t: "c",
          d: {
            t: "a",
            d: {}
          }
        }), a.f("Ending transmission on primary"), a.J.send({
          t: "c",
          d: {
            t: "n",
            d: {}
          }
        }), a.hd = a.D, Eh(a)) : (a.f("sending ping on secondary."), a.D.send({
          t: "c",
          d: {
            t: "p",
            d: {}
          }
        }));
      }
      yh.prototype.Id = function(a) {
        Gh(this);
        this.jc(a);
      };
      function Gh(a) {
        a.Ab || (a.Re--, 0 >= a.Re && (a.f("Primary connection is healthy."), a.Ab = !0, a.J.Ed()));
      }
      function Dh(a, b) {
        a.D = new b("c:" + a.id + ":" + a.ff++, a.F, a.Nf);
        a.Mf = b.responsesRequiredToBeHealthy || 0;
        a.D.open(Ah(a, a.D), Bh(a, a.D));
        setTimeout(function() {
          a.D && (a.f("Timed out trying to upgrade."), a.D.close());
        }, Math.floor(6E4));
      }
      function Ch(a, b, c) {
        a.f("Realtime connection established.");
        a.J = b;
        a.Ta = 1;
        a.Wc && (a.Wc(c, a.Nf), a.Wc = null);
        0 === a.Re ? (a.f("Primary connection is healthy."), a.Ab = !0) : setTimeout(function() {
          Hh(a);
        }, Math.floor(5E3));
      }
      function Hh(a) {
        a.Ab || 1 !== a.Ta || (a.f("sending ping on primary."), Jh(a, {
          t: "c",
          d: {
            t: "p",
            d: {}
          }
        }));
      }
      function Jh(a, b) {
        if (1 !== a.Ta)
          throw "Connection is not connected";
        a.hd.send(b);
      }
      yh.prototype.close = function() {
        2 !== this.Ta && (this.f("Closing realtime connection."), this.Ta = 2, Fh(this), this.la && (this.la(), this.la = null));
      };
      function Fh(a) {
        a.f("Shutting down all connections");
        a.J && (a.J.close(), a.J = null);
        a.D && (a.D.close(), a.D = null);
        a.yd && (clearTimeout(a.yd), a.yd = null);
      }
      ;
      function Kh(a, b, c, d) {
        this.id = Lh++;
        this.f = Mc("p:" + this.id + ":");
        this.xf = this.Ee = !1;
        this.$ = {};
        this.qa = [];
        this.Yc = 0;
        this.Vc = [];
        this.oa = !1;
        this.Za = 1E3;
        this.Fd = 3E5;
        this.Gb = b;
        this.Uc = c;
        this.Oe = d;
        this.F = a;
        this.sb = this.Aa = this.Ia = this.Bb = this.We = null;
        this.Ob = !1;
        this.Td = {};
        this.Lg = 0;
        this.nf = !0;
        this.Lc = this.Ge = null;
        Mh(this, 0);
        He.ub().Eb("visible", this.Cg, this);
        -1 === a.host.indexOf("fblocal") && Ge.ub().Eb("online", this.Ag, this);
      }
      var Lh = 0,
          Nh = 0;
      g = Kh.prototype;
      g.Fa = function(a, b, c) {
        var d = ++this.Lg;
        a = {
          r: d,
          a: a,
          b: b
        };
        this.f(B(a));
        K(this.oa, "sendRequest call when we're not connected not allowed.");
        this.Ia.Fa(a);
        c && (this.Td[d] = c);
      };
      g.yf = function(a, b, c, d) {
        var e = a.va(),
            f = a.path.toString();
        this.f("Listen called for " + f + " " + e);
        this.$[f] = this.$[f] || {};
        K(fe(a.n) || !S(a.n), "listen() called for non-default but complete query");
        K(!this.$[f][e], "listen() called twice for same path/queryId.");
        a = {
          H: d,
          xd: b,
          Ig: a,
          tag: c
        };
        this.$[f][e] = a;
        this.oa && Oh(this, a);
      };
      function Oh(a, b) {
        var c = b.Ig,
            d = c.path.toString(),
            e = c.va();
        a.f("Listen on " + d + " for " + e);
        var f = {p: d};
        b.tag && (f.q = ee(c.n), f.t = b.tag);
        f.h = b.xd();
        a.Fa("q", f, function(f) {
          var k = f.d,
              l = f.s;
          if (k && "object" === typeof k && v(k, "w")) {
            var m = w(k, "w");
            ea(m) && 0 <= Na(m, "no_index") && O("Using an unspecified index. Consider adding " + ('".indexOn": "' + c.n.g.toString() + '"') + " at " + c.path.toString() + " to your security rules for better performance");
          }
          (a.$[d] && a.$[d][e]) === b && (a.f("listen response", f), "ok" !== l && Ph(a, d, e), b.H && b.H(l, k));
        });
      }
      g.M = function(a, b, c) {
        this.Aa = {
          ig: a,
          of: !1,
          zc: b,
          md: c
        };
        this.f("Authenticating using credential: " + a);
        Qh(this);
        (b = 40 == a.length) || (a = $c(a).Bc, b = "object" === typeof a && !0 === w(a, "admin"));
        b && (this.f("Admin auth credential detected.  Reducing max reconnect time."), this.Fd = 3E4);
      };
      g.ge = function(a) {
        delete this.Aa;
        this.oa && this.Fa("unauth", {}, function(b) {
          a(b.s, b.d);
        });
      };
      function Qh(a) {
        var b = a.Aa;
        a.oa && b && a.Fa("auth", {cred: b.ig}, function(c) {
          var d = c.s;
          c = c.d || "error";
          "ok" !== d && a.Aa === b && delete a.Aa;
          b.of ? "ok" !== d && b.md && b.md(d, c) : (b.of = !0, b.zc && b.zc(d, c));
        });
      }
      g.Rf = function(a, b) {
        var c = a.path.toString(),
            d = a.va();
        this.f("Unlisten called for " + c + " " + d);
        K(fe(a.n) || !S(a.n), "unlisten() called for non-default but complete query");
        if (Ph(this, c, d) && this.oa) {
          var e = ee(a.n);
          this.f("Unlisten on " + c + " for " + d);
          c = {p: c};
          b && (c.q = e, c.t = b);
          this.Fa("n", c);
        }
      };
      g.Me = function(a, b, c) {
        this.oa ? Rh(this, "o", a, b, c) : this.Vc.push({
          $c: a,
          action: "o",
          data: b,
          H: c
        });
      };
      g.Cf = function(a, b, c) {
        this.oa ? Rh(this, "om", a, b, c) : this.Vc.push({
          $c: a,
          action: "om",
          data: b,
          H: c
        });
      };
      g.Jd = function(a, b) {
        this.oa ? Rh(this, "oc", a, null, b) : this.Vc.push({
          $c: a,
          action: "oc",
          data: null,
          H: b
        });
      };
      function Rh(a, b, c, d, e) {
        c = {
          p: c,
          d: d
        };
        a.f("onDisconnect " + b, c);
        a.Fa(b, c, function(a) {
          e && setTimeout(function() {
            e(a.s, a.d);
          }, Math.floor(0));
        });
      }
      g.put = function(a, b, c, d) {
        Sh(this, "p", a, b, c, d);
      };
      g.zf = function(a, b, c, d) {
        Sh(this, "m", a, b, c, d);
      };
      function Sh(a, b, c, d, e, f) {
        d = {
          p: c,
          d: d
        };
        n(f) && (d.h = f);
        a.qa.push({
          action: b,
          Jf: d,
          H: e
        });
        a.Yc++;
        b = a.qa.length - 1;
        a.oa ? Th(a, b) : a.f("Buffering put: " + c);
      }
      function Th(a, b) {
        var c = a.qa[b].action,
            d = a.qa[b].Jf,
            e = a.qa[b].H;
        a.qa[b].Jg = a.oa;
        a.Fa(c, d, function(d) {
          a.f(c + " response", d);
          delete a.qa[b];
          a.Yc--;
          0 === a.Yc && (a.qa = []);
          e && e(d.s, d.d);
        });
      }
      g.Ue = function(a) {
        this.oa && (a = {c: a}, this.f("reportStats", a), this.Fa("s", a, function(a) {
          "ok" !== a.s && this.f("reportStats", "Error sending stats: " + a.d);
        }));
      };
      g.Id = function(a) {
        if ("r" in a) {
          this.f("from server: " + B(a));
          var b = a.r,
              c = this.Td[b];
          c && (delete this.Td[b], c(a.b));
        } else {
          if ("error" in a)
            throw "A server-side error has occurred: " + a.error;
          "a" in a && (b = a.a, c = a.b, this.f("handleServerMessage", b, c), "d" === b ? this.Gb(c.p, c.d, !1, c.t) : "m" === b ? this.Gb(c.p, c.d, !0, c.t) : "c" === b ? Uh(this, c.p, c.q) : "ac" === b ? (a = c.s, b = c.d, c = this.Aa, delete this.Aa, c && c.md && c.md(a, b)) : "sd" === b ? this.We ? this.We(c) : "msg" in c && "undefined" !== typeof console && console.log("FIREBASE: " + c.msg.replace("\n", "\nFIREBASE: ")) : Nc("Unrecognized action received from server: " + B(b) + "\nAre you using the latest client?"));
        }
      };
      g.Wc = function(a, b) {
        this.f("connection ready");
        this.oa = !0;
        this.Lc = (new Date).getTime();
        this.Oe({serverTimeOffset: a - (new Date).getTime()});
        this.Bb = b;
        if (this.nf) {
          var c = {};
          c["sdk.js." + hb.replace(/\./g, "-")] = 1;
          yg() && (c["framework.cordova"] = 1);
          this.Ue(c);
        }
        Vh(this);
        this.nf = !1;
        this.Uc(!0);
      };
      function Mh(a, b) {
        K(!a.Ia, "Scheduling a connect when we're already connected/ing?");
        a.sb && clearTimeout(a.sb);
        a.sb = setTimeout(function() {
          a.sb = null;
          Wh(a);
        }, Math.floor(b));
      }
      g.Cg = function(a) {
        a && !this.Ob && this.Za === this.Fd && (this.f("Window became visible.  Reducing delay."), this.Za = 1E3, this.Ia || Mh(this, 0));
        this.Ob = a;
      };
      g.Ag = function(a) {
        a ? (this.f("Browser went online."), this.Za = 1E3, this.Ia || Mh(this, 0)) : (this.f("Browser went offline.  Killing connection."), this.Ia && this.Ia.close());
      };
      g.Df = function() {
        this.f("data client disconnected");
        this.oa = !1;
        this.Ia = null;
        for (var a = 0; a < this.qa.length; a++) {
          var b = this.qa[a];
          b && "h" in b.Jf && b.Jg && (b.H && b.H("disconnect"), delete this.qa[a], this.Yc--);
        }
        0 === this.Yc && (this.qa = []);
        this.Td = {};
        Xh(this) && (this.Ob ? this.Lc && (3E4 < (new Date).getTime() - this.Lc && (this.Za = 1E3), this.Lc = null) : (this.f("Window isn't visible.  Delaying reconnect."), this.Za = this.Fd, this.Ge = (new Date).getTime()), a = Math.max(0, this.Za - ((new Date).getTime() - this.Ge)), a *= Math.random(), this.f("Trying to reconnect in " + a + "ms"), Mh(this, a), this.Za = Math.min(this.Fd, 1.3 * this.Za));
        this.Uc(!1);
      };
      function Wh(a) {
        if (Xh(a)) {
          a.f("Making a connection attempt");
          a.Ge = (new Date).getTime();
          a.Lc = null;
          var b = q(a.Id, a),
              c = q(a.Wc, a),
              d = q(a.Df, a),
              e = a.id + ":" + Nh++;
          a.Ia = new yh(e, a.F, b, c, d, function(b) {
            O(b + " (" + a.F.toString() + ")");
            a.xf = !0;
          }, a.Bb);
        }
      }
      g.yb = function() {
        this.Ee = !0;
        this.Ia ? this.Ia.close() : (this.sb && (clearTimeout(this.sb), this.sb = null), this.oa && this.Df());
      };
      g.rc = function() {
        this.Ee = !1;
        this.Za = 1E3;
        this.Ia || Mh(this, 0);
      };
      function Uh(a, b, c) {
        c = c ? Qa(c, function(a) {
          return Uc(a);
        }).join("$") : "default";
        (a = Ph(a, b, c)) && a.H && a.H("permission_denied");
      }
      function Ph(a, b, c) {
        b = (new L(b)).toString();
        var d;
        n(a.$[b]) ? (d = a.$[b][c], delete a.$[b][c], 0 === pa(a.$[b]) && delete a.$[b]) : d = void 0;
        return d;
      }
      function Vh(a) {
        Qh(a);
        r(a.$, function(b) {
          r(b, function(b) {
            Oh(a, b);
          });
        });
        for (var b = 0; b < a.qa.length; b++)
          a.qa[b] && Th(a, b);
        for (; a.Vc.length; )
          b = a.Vc.shift(), Rh(a, b.action, b.$c, b.data, b.H);
      }
      function Xh(a) {
        var b;
        b = Ge.ub().kc;
        return !a.xf && !a.Ee && b;
      }
      ;
      var V = {og: function() {
          ih = rh = !0;
        }};
      V.forceLongPolling = V.og;
      V.pg = function() {
        jh = !0;
      };
      V.forceWebSockets = V.pg;
      V.Pg = function(a, b) {
        a.k.Ra.We = b;
      };
      V.setSecurityDebugCallback = V.Pg;
      V.Ye = function(a, b) {
        a.k.Ye(b);
      };
      V.stats = V.Ye;
      V.Ze = function(a, b) {
        a.k.Ze(b);
      };
      V.statsIncrementCounter = V.Ze;
      V.sd = function(a) {
        return a.k.sd;
      };
      V.dataUpdateCount = V.sd;
      V.sg = function(a, b) {
        a.k.De = b;
      };
      V.interceptServerData = V.sg;
      V.yg = function(a) {
        new Ig(a);
      };
      V.onPopupOpen = V.yg;
      V.Ng = function(a) {
        sg = a;
      };
      V.setAuthenticationServer = V.Ng;
      function Q(a, b, c) {
        this.A = a;
        this.W = b;
        this.g = c;
      }
      Q.prototype.I = function() {
        x("Firebase.DataSnapshot.val", 0, 0, arguments.length);
        return this.A.I();
      };
      Q.prototype.val = Q.prototype.I;
      Q.prototype.mf = function() {
        x("Firebase.DataSnapshot.exportVal", 0, 0, arguments.length);
        return this.A.I(!0);
      };
      Q.prototype.exportVal = Q.prototype.mf;
      Q.prototype.ng = function() {
        x("Firebase.DataSnapshot.exists", 0, 0, arguments.length);
        return !this.A.e();
      };
      Q.prototype.exists = Q.prototype.ng;
      Q.prototype.u = function(a) {
        x("Firebase.DataSnapshot.child", 0, 1, arguments.length);
        ga(a) && (a = String(a));
        ig("Firebase.DataSnapshot.child", a);
        var b = new L(a),
            c = this.W.u(b);
        return new Q(this.A.Q(b), c, N);
      };
      Q.prototype.child = Q.prototype.u;
      Q.prototype.Da = function(a) {
        x("Firebase.DataSnapshot.hasChild", 1, 1, arguments.length);
        ig("Firebase.DataSnapshot.hasChild", a);
        var b = new L(a);
        return !this.A.Q(b).e();
      };
      Q.prototype.hasChild = Q.prototype.Da;
      Q.prototype.C = function() {
        x("Firebase.DataSnapshot.getPriority", 0, 0, arguments.length);
        return this.A.C().I();
      };
      Q.prototype.getPriority = Q.prototype.C;
      Q.prototype.forEach = function(a) {
        x("Firebase.DataSnapshot.forEach", 1, 1, arguments.length);
        A("Firebase.DataSnapshot.forEach", 1, a, !1);
        if (this.A.K())
          return !1;
        var b = this;
        return !!this.A.P(this.g, function(c, d) {
          return a(new Q(d, b.W.u(c), N));
        });
      };
      Q.prototype.forEach = Q.prototype.forEach;
      Q.prototype.wd = function() {
        x("Firebase.DataSnapshot.hasChildren", 0, 0, arguments.length);
        return this.A.K() ? !1 : !this.A.e();
      };
      Q.prototype.hasChildren = Q.prototype.wd;
      Q.prototype.name = function() {
        O("Firebase.DataSnapshot.name() being deprecated. Please use Firebase.DataSnapshot.key() instead.");
        x("Firebase.DataSnapshot.name", 0, 0, arguments.length);
        return this.key();
      };
      Q.prototype.name = Q.prototype.name;
      Q.prototype.key = function() {
        x("Firebase.DataSnapshot.key", 0, 0, arguments.length);
        return this.W.key();
      };
      Q.prototype.key = Q.prototype.key;
      Q.prototype.Db = function() {
        x("Firebase.DataSnapshot.numChildren", 0, 0, arguments.length);
        return this.A.Db();
      };
      Q.prototype.numChildren = Q.prototype.Db;
      Q.prototype.Ib = function() {
        x("Firebase.DataSnapshot.ref", 0, 0, arguments.length);
        return this.W;
      };
      Q.prototype.ref = Q.prototype.Ib;
      function Yh(a, b) {
        this.F = a;
        this.Ua = Rb(a);
        this.fd = null;
        this.da = new vb;
        this.Hd = 1;
        this.Ra = null;
        b || 0 <= ("object" === typeof window && window.navigator && window.navigator.userAgent || "").search(/googlebot|google webmaster tools|bingbot|yahoo! slurp|baiduspider|yandexbot|duckduckbot/i) ? (this.ba = new Ae(this.F, q(this.Gb, this)), setTimeout(q(this.Uc, this, !0), 0)) : this.ba = this.Ra = new Kh(this.F, q(this.Gb, this), q(this.Uc, this), q(this.Oe, this));
        this.Sg = Sb(a, q(function() {
          return new Mb(this.Ua, this.ba);
        }, this));
        this.uc = new Rf;
        this.Ce = new ob;
        var c = this;
        this.Cd = new vf({
          Xe: function(a, b, f, h) {
            b = [];
            f = c.Ce.j(a.path);
            f.e() || (b = xf(c.Cd, new Xb(bf, a.path, f)), setTimeout(function() {
              h("ok");
            }, 0));
            return b;
          },
          ae: ba
        });
        Zh(this, "connected", !1);
        this.la = new qc;
        this.M = new Sg(a, q(this.ba.M, this.ba), q(this.ba.ge, this.ba), q(this.Le, this));
        this.sd = 0;
        this.De = null;
        this.L = new vf({
          Xe: function(a, b, f, h) {
            c.ba.yf(a, f, b, function(b, e) {
              var f = h(b, e);
              Ab(c.da, a.path, f);
            });
            return [];
          },
          ae: function(a, b) {
            c.ba.Rf(a, b);
          }
        });
      }
      g = Yh.prototype;
      g.toString = function() {
        return (this.F.kb ? "https://" : "http://") + this.F.host;
      };
      g.name = function() {
        return this.F.hc;
      };
      function $h(a) {
        a = a.Ce.j(new L(".info/serverTimeOffset")).I() || 0;
        return (new Date).getTime() + a;
      }
      function ai(a) {
        a = a = {timestamp: $h(a)};
        a.timestamp = a.timestamp || (new Date).getTime();
        return a;
      }
      g.Gb = function(a, b, c, d) {
        this.sd++;
        var e = new L(a);
        b = this.De ? this.De(a, b) : b;
        a = [];
        d ? c ? (b = na(b, function(a) {
          return M(a);
        }), a = Ff(this.L, e, b, d)) : (b = M(b), a = Bf(this.L, e, b, d)) : c ? (d = na(b, function(a) {
          return M(a);
        }), a = Af(this.L, e, d)) : (d = M(b), a = xf(this.L, new Xb(bf, e, d)));
        d = e;
        0 < a.length && (d = bi(this, e));
        Ab(this.da, d, a);
      };
      g.Uc = function(a) {
        Zh(this, "connected", a);
        !1 === a && ci(this);
      };
      g.Oe = function(a) {
        var b = this;
        Wc(a, function(a, d) {
          Zh(b, d, a);
        });
      };
      g.Le = function(a) {
        Zh(this, "authenticated", a);
      };
      function Zh(a, b, c) {
        b = new L("/.info/" + b);
        c = M(c);
        var d = a.Ce;
        d.Wd = d.Wd.G(b, c);
        c = xf(a.Cd, new Xb(bf, b, c));
        Ab(a.da, b, c);
      }
      g.Kb = function(a, b, c, d) {
        this.f("set", {
          path: a.toString(),
          value: b,
          $g: c
        });
        var e = ai(this);
        b = M(b, c);
        var e = sc(b, e),
            f = this.Hd++,
            e = wf(this.L, a, e, f, !0);
        wb(this.da, e);
        var h = this;
        this.ba.put(a.toString(), b.I(!0), function(b, c) {
          var e = "ok" === b;
          e || O("set at " + a + " failed: " + b);
          e = zf(h.L, f, !e);
          Ab(h.da, a, e);
          di(d, b, c);
        });
        e = ei(this, a);
        bi(this, e);
        Ab(this.da, e, []);
      };
      g.update = function(a, b, c) {
        this.f("update", {
          path: a.toString(),
          value: b
        });
        var d = !0,
            e = ai(this),
            f = {};
        r(b, function(a, b) {
          d = !1;
          var c = M(a);
          f[b] = sc(c, e);
        });
        if (d)
          Cb("update() called with empty data.  Don't do anything."), di(c, "ok");
        else {
          var h = this.Hd++,
              k = yf(this.L, a, f, h);
          wb(this.da, k);
          var l = this;
          this.ba.zf(a.toString(), b, function(b, d) {
            var e = "ok" === b;
            e || O("update at " + a + " failed: " + b);
            var e = zf(l.L, h, !e),
                f = a;
            0 < e.length && (f = bi(l, a));
            Ab(l.da, f, e);
            di(c, b, d);
          });
          b = ei(this, a);
          bi(this, b);
          Ab(this.da, a, []);
        }
      };
      function ci(a) {
        a.f("onDisconnectEvents");
        var b = ai(a),
            c = [];
        rc(pc(a.la, b), G, function(b, e) {
          c = c.concat(xf(a.L, new Xb(bf, b, e)));
          var f = ei(a, b);
          bi(a, f);
        });
        a.la = new qc;
        Ab(a.da, G, c);
      }
      g.Jd = function(a, b) {
        var c = this;
        this.ba.Jd(a.toString(), function(d, e) {
          "ok" === d && rg(c.la, a);
          di(b, d, e);
        });
      };
      function fi(a, b, c, d) {
        var e = M(c);
        a.ba.Me(b.toString(), e.I(!0), function(c, h) {
          "ok" === c && a.la.nc(b, e);
          di(d, c, h);
        });
      }
      function gi(a, b, c, d, e) {
        var f = M(c, d);
        a.ba.Me(b.toString(), f.I(!0), function(c, d) {
          "ok" === c && a.la.nc(b, f);
          di(e, c, d);
        });
      }
      function hi(a, b, c, d) {
        var e = !0,
            f;
        for (f in c)
          e = !1;
        e ? (Cb("onDisconnect().update() called with empty data.  Don't do anything."), di(d, "ok")) : a.ba.Cf(b.toString(), c, function(e, f) {
          if ("ok" === e)
            for (var l in c) {
              var m = M(c[l]);
              a.la.nc(b.u(l), m);
            }
          di(d, e, f);
        });
      }
      function ii(a, b, c) {
        c = ".info" === E(b.path) ? a.Cd.Pb(b, c) : a.L.Pb(b, c);
        yb(a.da, b.path, c);
      }
      g.yb = function() {
        this.Ra && this.Ra.yb();
      };
      g.rc = function() {
        this.Ra && this.Ra.rc();
      };
      g.Ye = function(a) {
        if ("undefined" !== typeof console) {
          a ? (this.fd || (this.fd = new Lb(this.Ua)), a = this.fd.get()) : a = this.Ua.get();
          var b = Ra(sa(a), function(a, b) {
            return Math.max(b.length, a);
          }, 0),
              c;
          for (c in a) {
            for (var d = a[c],
                e = c.length; e < b + 2; e++)
              c += " ";
            console.log(c + d);
          }
        }
      };
      g.Ze = function(a) {
        Ob(this.Ua, a);
        this.Sg.Of[a] = !0;
      };
      g.f = function(a) {
        var b = "";
        this.Ra && (b = this.Ra.id + ":");
        Cb(b, arguments);
      };
      function di(a, b, c) {
        a && Db(function() {
          if ("ok" == b)
            a(null);
          else {
            var d = (b || "error").toUpperCase(),
                e = d;
            c && (e += ": " + c);
            e = Error(e);
            e.code = d;
            a(e);
          }
        });
      }
      ;
      function ji(a, b, c, d, e) {
        function f() {}
        a.f("transaction on " + b);
        var h = new U(a, b);
        h.Eb("value", f);
        c = {
          path: b,
          update: c,
          H: d,
          status: null,
          Ff: Ec(),
          cf: e,
          Lf: 0,
          ie: function() {
            h.ic("value", f);
          },
          ke: null,
          Ba: null,
          pd: null,
          qd: null,
          rd: null
        };
        d = a.L.za(b, void 0) || C;
        c.pd = d;
        d = c.update(d.I());
        if (n(d)) {
          cg("transaction failed: Data returned ", d, c.path);
          c.status = 1;
          e = Sf(a.uc, b);
          var k = e.Ca() || [];
          k.push(c);
          Tf(e, k);
          "object" === typeof d && null !== d && v(d, ".priority") ? (k = w(d, ".priority"), K(ag(k), "Invalid priority returned by transaction. Priority must be a valid string, finite number, server value, or null.")) : k = (a.L.za(b) || C).C().I();
          e = ai(a);
          d = M(d, k);
          e = sc(d, e);
          c.qd = d;
          c.rd = e;
          c.Ba = a.Hd++;
          c = wf(a.L, b, e, c.Ba, c.cf);
          Ab(a.da, b, c);
          ki(a);
        } else
          c.ie(), c.qd = null, c.rd = null, c.H && (a = new Q(c.pd, new U(a, c.path), N), c.H(null, !1, a));
      }
      function ki(a, b) {
        var c = b || a.uc;
        b || li(a, c);
        if (null !== c.Ca()) {
          var d = mi(a, c);
          K(0 < d.length, "Sending zero length transaction queue");
          Sa(d, function(a) {
            return 1 === a.status;
          }) && ni(a, c.path(), d);
        } else
          c.wd() && c.P(function(b) {
            ki(a, b);
          });
      }
      function ni(a, b, c) {
        for (var d = Qa(c, function(a) {
          return a.Ba;
        }),
            e = a.L.za(b, d) || C,
            d = e,
            e = e.hash(),
            f = 0; f < c.length; f++) {
          var h = c[f];
          K(1 === h.status, "tryToSendTransactionQueue_: items in queue should all be run.");
          h.status = 2;
          h.Lf++;
          var k = T(b, h.path),
              d = d.G(k, h.qd);
        }
        d = d.I(!0);
        a.ba.put(b.toString(), d, function(d) {
          a.f("transaction put response", {
            path: b.toString(),
            status: d
          });
          var e = [];
          if ("ok" === d) {
            d = [];
            for (f = 0; f < c.length; f++) {
              c[f].status = 3;
              e = e.concat(zf(a.L, c[f].Ba));
              if (c[f].H) {
                var h = c[f].rd,
                    k = new U(a, c[f].path);
                d.push(q(c[f].H, null, null, !0, new Q(h, k, N)));
              }
              c[f].ie();
            }
            li(a, Sf(a.uc, b));
            ki(a);
            Ab(a.da, b, e);
            for (f = 0; f < d.length; f++)
              Db(d[f]);
          } else {
            if ("datastale" === d)
              for (f = 0; f < c.length; f++)
                c[f].status = 4 === c[f].status ? 5 : 1;
            else
              for (O("transaction at " + b.toString() + " failed: " + d), f = 0; f < c.length; f++)
                c[f].status = 5, c[f].ke = d;
            bi(a, b);
          }
        }, e);
      }
      function bi(a, b) {
        var c = oi(a, b),
            d = c.path(),
            c = mi(a, c);
        pi(a, c, d);
        return d;
      }
      function pi(a, b, c) {
        if (0 !== b.length) {
          for (var d = [],
              e = [],
              f = Qa(b, function(a) {
                return a.Ba;
              }),
              h = 0; h < b.length; h++) {
            var k = b[h],
                l = T(c, k.path),
                m = !1,
                t;
            K(null !== l, "rerunTransactionsUnderNode_: relativePath should not be null.");
            if (5 === k.status)
              m = !0, t = k.ke, e = e.concat(zf(a.L, k.Ba, !0));
            else if (1 === k.status)
              if (25 <= k.Lf)
                m = !0, t = "maxretry", e = e.concat(zf(a.L, k.Ba, !0));
              else {
                var z = a.L.za(k.path, f) || C;
                k.pd = z;
                var I = b[h].update(z.I());
                n(I) ? (cg("transaction failed: Data returned ", I, k.path), l = M(I), "object" === typeof I && null != I && v(I, ".priority") || (l = l.ga(z.C())), z = k.Ba, I = ai(a), I = sc(l, I), k.qd = l, k.rd = I, k.Ba = a.Hd++, Va(f, z), e = e.concat(wf(a.L, k.path, I, k.Ba, k.cf)), e = e.concat(zf(a.L, z, !0))) : (m = !0, t = "nodata", e = e.concat(zf(a.L, k.Ba, !0)));
              }
            Ab(a.da, c, e);
            e = [];
            m && (b[h].status = 3, setTimeout(b[h].ie, Math.floor(0)), b[h].H && ("nodata" === t ? (k = new U(a, b[h].path), d.push(q(b[h].H, null, null, !1, new Q(b[h].pd, k, N)))) : d.push(q(b[h].H, null, Error(t), !1, null))));
          }
          li(a, a.uc);
          for (h = 0; h < d.length; h++)
            Db(d[h]);
          ki(a);
        }
      }
      function oi(a, b) {
        for (var c,
            d = a.uc; null !== (c = E(b)) && null === d.Ca(); )
          d = Sf(d, c), b = H(b);
        return d;
      }
      function mi(a, b) {
        var c = [];
        qi(a, b, c);
        c.sort(function(a, b) {
          return a.Ff - b.Ff;
        });
        return c;
      }
      function qi(a, b, c) {
        var d = b.Ca();
        if (null !== d)
          for (var e = 0; e < d.length; e++)
            c.push(d[e]);
        b.P(function(b) {
          qi(a, b, c);
        });
      }
      function li(a, b) {
        var c = b.Ca();
        if (c) {
          for (var d = 0,
              e = 0; e < c.length; e++)
            3 !== c[e].status && (c[d] = c[e], d++);
          c.length = d;
          Tf(b, 0 < c.length ? c : null);
        }
        b.P(function(b) {
          li(a, b);
        });
      }
      function ei(a, b) {
        var c = oi(a, b).path(),
            d = Sf(a.uc, b);
        Wf(d, function(b) {
          ri(a, b);
        });
        ri(a, d);
        Vf(d, function(b) {
          ri(a, b);
        });
        return c;
      }
      function ri(a, b) {
        var c = b.Ca();
        if (null !== c) {
          for (var d = [],
              e = [],
              f = -1,
              h = 0; h < c.length; h++)
            4 !== c[h].status && (2 === c[h].status ? (K(f === h - 1, "All SENT items should be at beginning of queue."), f = h, c[h].status = 4, c[h].ke = "set") : (K(1 === c[h].status, "Unexpected transaction status in abort"), c[h].ie(), e = e.concat(zf(a.L, c[h].Ba, !0)), c[h].H && d.push(q(c[h].H, null, Error("set"), !1, null))));
          -1 === f ? Tf(b, null) : c.length = f + 1;
          Ab(a.da, b.path(), e);
          for (h = 0; h < d.length; h++)
            Db(d[h]);
        }
      }
      ;
      function W() {
        this.oc = {};
        this.Sf = !1;
      }
      W.prototype.yb = function() {
        for (var a in this.oc)
          this.oc[a].yb();
      };
      W.prototype.rc = function() {
        for (var a in this.oc)
          this.oc[a].rc();
      };
      W.prototype.ve = function() {
        this.Sf = !0;
      };
      ca(W);
      W.prototype.interrupt = W.prototype.yb;
      W.prototype.resume = W.prototype.rc;
      function X(a, b) {
        this.bd = a;
        this.ra = b;
      }
      X.prototype.cancel = function(a) {
        x("Firebase.onDisconnect().cancel", 0, 1, arguments.length);
        A("Firebase.onDisconnect().cancel", 1, a, !0);
        this.bd.Jd(this.ra, a || null);
      };
      X.prototype.cancel = X.prototype.cancel;
      X.prototype.remove = function(a) {
        x("Firebase.onDisconnect().remove", 0, 1, arguments.length);
        jg("Firebase.onDisconnect().remove", this.ra);
        A("Firebase.onDisconnect().remove", 1, a, !0);
        fi(this.bd, this.ra, null, a);
      };
      X.prototype.remove = X.prototype.remove;
      X.prototype.set = function(a, b) {
        x("Firebase.onDisconnect().set", 1, 2, arguments.length);
        jg("Firebase.onDisconnect().set", this.ra);
        bg("Firebase.onDisconnect().set", a, this.ra, !1);
        A("Firebase.onDisconnect().set", 2, b, !0);
        fi(this.bd, this.ra, a, b);
      };
      X.prototype.set = X.prototype.set;
      X.prototype.Kb = function(a, b, c) {
        x("Firebase.onDisconnect().setWithPriority", 2, 3, arguments.length);
        jg("Firebase.onDisconnect().setWithPriority", this.ra);
        bg("Firebase.onDisconnect().setWithPriority", a, this.ra, !1);
        fg("Firebase.onDisconnect().setWithPriority", 2, b);
        A("Firebase.onDisconnect().setWithPriority", 3, c, !0);
        gi(this.bd, this.ra, a, b, c);
      };
      X.prototype.setWithPriority = X.prototype.Kb;
      X.prototype.update = function(a, b) {
        x("Firebase.onDisconnect().update", 1, 2, arguments.length);
        jg("Firebase.onDisconnect().update", this.ra);
        if (ea(a)) {
          for (var c = {},
              d = 0; d < a.length; ++d)
            c["" + d] = a[d];
          a = c;
          O("Passing an Array to Firebase.onDisconnect().update() is deprecated. Use set() if you want to overwrite the existing data, or an Object with integer keys if you really do want to only update some of the children.");
        }
        eg("Firebase.onDisconnect().update", a, this.ra);
        A("Firebase.onDisconnect().update", 2, b, !0);
        hi(this.bd, this.ra, a, b);
      };
      X.prototype.update = X.prototype.update;
      function Y(a, b, c, d) {
        this.k = a;
        this.path = b;
        this.n = c;
        this.lc = d;
      }
      function si(a) {
        var b = null,
            c = null;
        a.ma && (b = nd(a));
        a.pa && (c = pd(a));
        if (a.g === Qd) {
          if (a.ma) {
            if ("[MIN_NAME]" != md(a))
              throw Error("Query: When ordering by key, you may only pass one argument to startAt(), endAt(), or equalTo().");
            if ("string" !== typeof b)
              throw Error("Query: When ordering by key, the argument passed to startAt(), endAt(),or equalTo() must be a string.");
          }
          if (a.pa) {
            if ("[MAX_NAME]" != od(a))
              throw Error("Query: When ordering by key, you may only pass one argument to startAt(), endAt(), or equalTo().");
            if ("string" !== typeof c)
              throw Error("Query: When ordering by key, the argument passed to startAt(), endAt(),or equalTo() must be a string.");
          }
        } else if (a.g === N) {
          if (null != b && !ag(b) || null != c && !ag(c))
            throw Error("Query: When ordering by priority, the first argument passed to startAt(), endAt(), or equalTo() must be a valid priority value (null, a number, or a string).");
        } else if (K(a.g instanceof Ud || a.g === $d, "unknown index type."), null != b && "object" === typeof b || null != c && "object" === typeof c)
          throw Error("Query: First argument passed to startAt(), endAt(), or equalTo() cannot be an object.");
      }
      function ti(a) {
        if (a.ma && a.pa && a.ja && (!a.ja || "" === a.Nb))
          throw Error("Query: Can't combine startAt(), endAt(), and limit(). Use limitToFirst() or limitToLast() instead.");
      }
      function ui(a, b) {
        if (!0 === a.lc)
          throw Error(b + ": You can't combine multiple orderBy calls.");
      }
      g = Y.prototype;
      g.Ib = function() {
        x("Query.ref", 0, 0, arguments.length);
        return new U(this.k, this.path);
      };
      g.Eb = function(a, b, c, d) {
        x("Query.on", 2, 4, arguments.length);
        gg("Query.on", a, !1);
        A("Query.on", 2, b, !1);
        var e = vi("Query.on", c, d);
        if ("value" === a)
          ii(this.k, this, new id(b, e.cancel || null, e.Ma || null));
        else {
          var f = {};
          f[a] = b;
          ii(this.k, this, new jd(f, e.cancel, e.Ma));
        }
        return b;
      };
      g.ic = function(a, b, c) {
        x("Query.off", 0, 3, arguments.length);
        gg("Query.off", a, !0);
        A("Query.off", 2, b, !0);
        mb("Query.off", 3, c);
        var d = null,
            e = null;
        "value" === a ? d = new id(b || null, null, c || null) : a && (b && (e = {}, e[a] = b), d = new jd(e, null, c || null));
        e = this.k;
        d = ".info" === E(this.path) ? e.Cd.jb(this, d) : e.L.jb(this, d);
        yb(e.da, this.path, d);
      };
      g.Dg = function(a, b) {
        function c(h) {
          f && (f = !1, e.ic(a, c), b.call(d.Ma, h));
        }
        x("Query.once", 2, 4, arguments.length);
        gg("Query.once", a, !1);
        A("Query.once", 2, b, !1);
        var d = vi("Query.once", arguments[2], arguments[3]),
            e = this,
            f = !0;
        this.Eb(a, c, function(b) {
          e.ic(a, c);
          d.cancel && d.cancel.call(d.Ma, b);
        });
      };
      g.He = function(a) {
        O("Query.limit() being deprecated. Please use Query.limitToFirst() or Query.limitToLast() instead.");
        x("Query.limit", 1, 1, arguments.length);
        if (!ga(a) || Math.floor(a) !== a || 0 >= a)
          throw Error("Query.limit: First argument must be a positive integer.");
        if (this.n.ja)
          throw Error("Query.limit: Limit was already set (by another call to limit, limitToFirst, orlimitToLast.");
        var b = this.n.He(a);
        ti(b);
        return new Y(this.k, this.path, b, this.lc);
      };
      g.Ie = function(a) {
        x("Query.limitToFirst", 1, 1, arguments.length);
        if (!ga(a) || Math.floor(a) !== a || 0 >= a)
          throw Error("Query.limitToFirst: First argument must be a positive integer.");
        if (this.n.ja)
          throw Error("Query.limitToFirst: Limit was already set (by another call to limit, limitToFirst, or limitToLast).");
        return new Y(this.k, this.path, this.n.Ie(a), this.lc);
      };
      g.Je = function(a) {
        x("Query.limitToLast", 1, 1, arguments.length);
        if (!ga(a) || Math.floor(a) !== a || 0 >= a)
          throw Error("Query.limitToLast: First argument must be a positive integer.");
        if (this.n.ja)
          throw Error("Query.limitToLast: Limit was already set (by another call to limit, limitToFirst, or limitToLast).");
        return new Y(this.k, this.path, this.n.Je(a), this.lc);
      };
      g.Eg = function(a) {
        x("Query.orderByChild", 1, 1, arguments.length);
        if ("$key" === a)
          throw Error('Query.orderByChild: "$key" is invalid.  Use Query.orderByKey() instead.');
        if ("$priority" === a)
          throw Error('Query.orderByChild: "$priority" is invalid.  Use Query.orderByPriority() instead.');
        if ("$value" === a)
          throw Error('Query.orderByChild: "$value" is invalid.  Use Query.orderByValue() instead.');
        ig("Query.orderByChild", a);
        ui(this, "Query.orderByChild");
        var b = new L(a);
        if (b.e())
          throw Error("Query.orderByChild: cannot pass in empty path.  Use Query.orderByValue() instead.");
        b = new Ud(b);
        b = de(this.n, b);
        si(b);
        return new Y(this.k, this.path, b, !0);
      };
      g.Fg = function() {
        x("Query.orderByKey", 0, 0, arguments.length);
        ui(this, "Query.orderByKey");
        var a = de(this.n, Qd);
        si(a);
        return new Y(this.k, this.path, a, !0);
      };
      g.Gg = function() {
        x("Query.orderByPriority", 0, 0, arguments.length);
        ui(this, "Query.orderByPriority");
        var a = de(this.n, N);
        si(a);
        return new Y(this.k, this.path, a, !0);
      };
      g.Hg = function() {
        x("Query.orderByValue", 0, 0, arguments.length);
        ui(this, "Query.orderByValue");
        var a = de(this.n, $d);
        si(a);
        return new Y(this.k, this.path, a, !0);
      };
      g.$d = function(a, b) {
        x("Query.startAt", 0, 2, arguments.length);
        bg("Query.startAt", a, this.path, !0);
        hg("Query.startAt", b);
        var c = this.n.$d(a, b);
        ti(c);
        si(c);
        if (this.n.ma)
          throw Error("Query.startAt: Starting point was already set (by another call to startAt or equalTo).");
        n(a) || (b = a = null);
        return new Y(this.k, this.path, c, this.lc);
      };
      g.td = function(a, b) {
        x("Query.endAt", 0, 2, arguments.length);
        bg("Query.endAt", a, this.path, !0);
        hg("Query.endAt", b);
        var c = this.n.td(a, b);
        ti(c);
        si(c);
        if (this.n.pa)
          throw Error("Query.endAt: Ending point was already set (by another call to endAt or equalTo).");
        return new Y(this.k, this.path, c, this.lc);
      };
      g.kg = function(a, b) {
        x("Query.equalTo", 1, 2, arguments.length);
        bg("Query.equalTo", a, this.path, !1);
        hg("Query.equalTo", b);
        if (this.n.ma)
          throw Error("Query.equalTo: Starting point was already set (by another call to endAt or equalTo).");
        if (this.n.pa)
          throw Error("Query.equalTo: Ending point was already set (by another call to endAt or equalTo).");
        return this.$d(a, b).td(a, b);
      };
      g.toString = function() {
        x("Query.toString", 0, 0, arguments.length);
        for (var a = this.path,
            b = "",
            c = a.Z; c < a.o.length; c++)
          "" !== a.o[c] && (b += "/" + encodeURIComponent(String(a.o[c])));
        return this.k.toString() + (b || "/");
      };
      g.va = function() {
        var a = Uc(ee(this.n));
        return "{}" === a ? "default" : a;
      };
      function vi(a, b, c) {
        var d = {
          cancel: null,
          Ma: null
        };
        if (b && c)
          d.cancel = b, A(a, 3, d.cancel, !0), d.Ma = c, mb(a, 4, d.Ma);
        else if (b)
          if ("object" === typeof b && null !== b)
            d.Ma = b;
          else if ("function" === typeof b)
            d.cancel = b;
          else
            throw Error(y(a, 3, !0) + " must either be a cancel callback or a context object.");
        return d;
      }
      Y.prototype.ref = Y.prototype.Ib;
      Y.prototype.on = Y.prototype.Eb;
      Y.prototype.off = Y.prototype.ic;
      Y.prototype.once = Y.prototype.Dg;
      Y.prototype.limit = Y.prototype.He;
      Y.prototype.limitToFirst = Y.prototype.Ie;
      Y.prototype.limitToLast = Y.prototype.Je;
      Y.prototype.orderByChild = Y.prototype.Eg;
      Y.prototype.orderByKey = Y.prototype.Fg;
      Y.prototype.orderByPriority = Y.prototype.Gg;
      Y.prototype.orderByValue = Y.prototype.Hg;
      Y.prototype.startAt = Y.prototype.$d;
      Y.prototype.endAt = Y.prototype.td;
      Y.prototype.equalTo = Y.prototype.kg;
      Y.prototype.toString = Y.prototype.toString;
      var Z = {};
      Z.vc = Kh;
      Z.DataConnection = Z.vc;
      Kh.prototype.Rg = function(a, b) {
        this.Fa("q", {p: a}, b);
      };
      Z.vc.prototype.simpleListen = Z.vc.prototype.Rg;
      Kh.prototype.jg = function(a, b) {
        this.Fa("echo", {d: a}, b);
      };
      Z.vc.prototype.echo = Z.vc.prototype.jg;
      Kh.prototype.interrupt = Kh.prototype.yb;
      Z.Vf = yh;
      Z.RealTimeConnection = Z.Vf;
      yh.prototype.sendRequest = yh.prototype.Fa;
      yh.prototype.close = yh.prototype.close;
      Z.rg = function(a) {
        var b = Kh.prototype.put;
        Kh.prototype.put = function(c, d, e, f) {
          n(f) && (f = a());
          b.call(this, c, d, e, f);
        };
        return function() {
          Kh.prototype.put = b;
        };
      };
      Z.hijackHash = Z.rg;
      Z.Uf = zc;
      Z.ConnectionTarget = Z.Uf;
      Z.va = function(a) {
        return a.va();
      };
      Z.queryIdentifier = Z.va;
      Z.tg = function(a) {
        return a.k.Ra.$;
      };
      Z.listens = Z.tg;
      Z.ve = function(a) {
        a.ve();
      };
      Z.forceRestClient = Z.ve;
      function U(a, b) {
        var c,
            d,
            e;
        if (a instanceof Yh)
          c = a, d = b;
        else {
          x("new Firebase", 1, 2, arguments.length);
          d = Pc(arguments[0]);
          c = d.Tg;
          "firebase" === d.domain && Oc(d.host + " is no longer supported. Please use <YOUR FIREBASE>.firebaseio.com instead");
          c && "undefined" != c || Oc("Cannot parse Firebase url. Please use https://<YOUR FIREBASE>.firebaseio.com");
          d.kb || "undefined" !== typeof window && window.location && window.location.protocol && -1 !== window.location.protocol.indexOf("https:") && O("Insecure Firebase access from a secure page. Please use https in calls to new Firebase().");
          c = new zc(d.host, d.kb, c, "ws" === d.scheme || "wss" === d.scheme);
          d = new L(d.$c);
          e = d.toString();
          var f;
          !(f = !p(c.host) || 0 === c.host.length || !$f(c.hc)) && (f = 0 !== e.length) && (e && (e = e.replace(/^\/*\.info(\/|$)/, "/")), f = !(p(e) && 0 !== e.length && !Yf.test(e)));
          if (f)
            throw Error(y("new Firebase", 1, !1) + 'must be a valid firebase URL and the path can\'t contain ".", "#", "$", "[", or "]".');
          if (b)
            if (b instanceof W)
              e = b;
            else if (p(b))
              e = W.ub(), c.Od = b;
            else
              throw Error("Expected a valid Firebase.Context for second argument to new Firebase()");
          else
            e = W.ub();
          f = c.toString();
          var h = w(e.oc, f);
          h || (h = new Yh(c, e.Sf), e.oc[f] = h);
          c = h;
        }
        Y.call(this, c, d, be, !1);
      }
      ma(U, Y);
      var wi = U,
          xi = ["Firebase"],
          yi = aa;
      xi[0] in yi || !yi.execScript || yi.execScript("var " + xi[0]);
      for (var zi; xi.length && (zi = xi.shift()); )
        !xi.length && n(wi) ? yi[zi] = wi : yi = yi[zi] ? yi[zi] : yi[zi] = {};
      U.goOffline = function() {
        x("Firebase.goOffline", 0, 0, arguments.length);
        W.ub().yb();
      };
      U.goOnline = function() {
        x("Firebase.goOnline", 0, 0, arguments.length);
        W.ub().rc();
      };
      function Lc(a, b) {
        K(!b || !0 === a || !1 === a, "Can't turn on custom loggers persistently.");
        !0 === a ? ("undefined" !== typeof console && ("function" === typeof console.log ? Bb = q(console.log, console) : "object" === typeof console.log && (Bb = function(a) {
          console.log(a);
        })), b && yc.set("logging_enabled", !0)) : a ? Bb = a : (Bb = null, yc.remove("logging_enabled"));
      }
      U.enableLogging = Lc;
      U.ServerValue = {TIMESTAMP: {".sv": "timestamp"}};
      U.SDK_VERSION = hb;
      U.INTERNAL = V;
      U.Context = W;
      U.TEST_ACCESS = Z;
      U.prototype.name = function() {
        O("Firebase.name() being deprecated. Please use Firebase.key() instead.");
        x("Firebase.name", 0, 0, arguments.length);
        return this.key();
      };
      U.prototype.name = U.prototype.name;
      U.prototype.key = function() {
        x("Firebase.key", 0, 0, arguments.length);
        return this.path.e() ? null : Ld(this.path);
      };
      U.prototype.key = U.prototype.key;
      U.prototype.u = function(a) {
        x("Firebase.child", 1, 1, arguments.length);
        if (ga(a))
          a = String(a);
        else if (!(a instanceof L))
          if (null === E(this.path)) {
            var b = a;
            b && (b = b.replace(/^\/*\.info(\/|$)/, "/"));
            ig("Firebase.child", b);
          } else
            ig("Firebase.child", a);
        return new U(this.k, this.path.u(a));
      };
      U.prototype.child = U.prototype.u;
      U.prototype.parent = function() {
        x("Firebase.parent", 0, 0, arguments.length);
        var a = this.path.parent();
        return null === a ? null : new U(this.k, a);
      };
      U.prototype.parent = U.prototype.parent;
      U.prototype.root = function() {
        x("Firebase.ref", 0, 0, arguments.length);
        for (var a = this; null !== a.parent(); )
          a = a.parent();
        return a;
      };
      U.prototype.root = U.prototype.root;
      U.prototype.set = function(a, b) {
        x("Firebase.set", 1, 2, arguments.length);
        jg("Firebase.set", this.path);
        bg("Firebase.set", a, this.path, !1);
        A("Firebase.set", 2, b, !0);
        this.k.Kb(this.path, a, null, b || null);
      };
      U.prototype.set = U.prototype.set;
      U.prototype.update = function(a, b) {
        x("Firebase.update", 1, 2, arguments.length);
        jg("Firebase.update", this.path);
        if (ea(a)) {
          for (var c = {},
              d = 0; d < a.length; ++d)
            c["" + d] = a[d];
          a = c;
          O("Passing an Array to Firebase.update() is deprecated. Use set() if you want to overwrite the existing data, or an Object with integer keys if you really do want to only update some of the children.");
        }
        eg("Firebase.update", a, this.path);
        A("Firebase.update", 2, b, !0);
        this.k.update(this.path, a, b || null);
      };
      U.prototype.update = U.prototype.update;
      U.prototype.Kb = function(a, b, c) {
        x("Firebase.setWithPriority", 2, 3, arguments.length);
        jg("Firebase.setWithPriority", this.path);
        bg("Firebase.setWithPriority", a, this.path, !1);
        fg("Firebase.setWithPriority", 2, b);
        A("Firebase.setWithPriority", 3, c, !0);
        if (".length" === this.key() || ".keys" === this.key())
          throw "Firebase.setWithPriority failed: " + this.key() + " is a read-only object.";
        this.k.Kb(this.path, a, b, c || null);
      };
      U.prototype.setWithPriority = U.prototype.Kb;
      U.prototype.remove = function(a) {
        x("Firebase.remove", 0, 1, arguments.length);
        jg("Firebase.remove", this.path);
        A("Firebase.remove", 1, a, !0);
        this.set(null, a);
      };
      U.prototype.remove = U.prototype.remove;
      U.prototype.transaction = function(a, b, c) {
        x("Firebase.transaction", 1, 3, arguments.length);
        jg("Firebase.transaction", this.path);
        A("Firebase.transaction", 1, a, !1);
        A("Firebase.transaction", 2, b, !0);
        if (n(c) && "boolean" != typeof c)
          throw Error(y("Firebase.transaction", 3, !0) + "must be a boolean.");
        if (".length" === this.key() || ".keys" === this.key())
          throw "Firebase.transaction failed: " + this.key() + " is a read-only object.";
        "undefined" === typeof c && (c = !0);
        ji(this.k, this.path, a, b || null, c);
      };
      U.prototype.transaction = U.prototype.transaction;
      U.prototype.Og = function(a, b) {
        x("Firebase.setPriority", 1, 2, arguments.length);
        jg("Firebase.setPriority", this.path);
        fg("Firebase.setPriority", 1, a);
        A("Firebase.setPriority", 2, b, !0);
        this.k.Kb(this.path.u(".priority"), a, null, b);
      };
      U.prototype.setPriority = U.prototype.Og;
      U.prototype.push = function(a, b) {
        x("Firebase.push", 0, 2, arguments.length);
        jg("Firebase.push", this.path);
        bg("Firebase.push", a, this.path, !0);
        A("Firebase.push", 2, b, !0);
        var c = $h(this.k),
            c = Fe(c),
            c = this.u(c);
        "undefined" !== typeof a && null !== a && c.set(a, b);
        return c;
      };
      U.prototype.push = U.prototype.push;
      U.prototype.hb = function() {
        jg("Firebase.onDisconnect", this.path);
        return new X(this.k, this.path);
      };
      U.prototype.onDisconnect = U.prototype.hb;
      U.prototype.M = function(a, b, c) {
        O("FirebaseRef.auth() being deprecated. Please use FirebaseRef.authWithCustomToken() instead.");
        x("Firebase.auth", 1, 3, arguments.length);
        kg("Firebase.auth", a);
        A("Firebase.auth", 2, b, !0);
        A("Firebase.auth", 3, b, !0);
        Yg(this.k.M, a, {}, {remember: "none"}, b, c);
      };
      U.prototype.auth = U.prototype.M;
      U.prototype.ge = function(a) {
        x("Firebase.unauth", 0, 1, arguments.length);
        A("Firebase.unauth", 1, a, !0);
        Zg(this.k.M, a);
      };
      U.prototype.unauth = U.prototype.ge;
      U.prototype.xe = function() {
        x("Firebase.getAuth", 0, 0, arguments.length);
        return this.k.M.xe();
      };
      U.prototype.getAuth = U.prototype.xe;
      U.prototype.xg = function(a, b) {
        x("Firebase.onAuth", 1, 2, arguments.length);
        A("Firebase.onAuth", 1, a, !1);
        mb("Firebase.onAuth", 2, b);
        this.k.M.Eb("auth_status", a, b);
      };
      U.prototype.onAuth = U.prototype.xg;
      U.prototype.wg = function(a, b) {
        x("Firebase.offAuth", 1, 2, arguments.length);
        A("Firebase.offAuth", 1, a, !1);
        mb("Firebase.offAuth", 2, b);
        this.k.M.ic("auth_status", a, b);
      };
      U.prototype.offAuth = U.prototype.wg;
      U.prototype.Zf = function(a, b, c) {
        x("Firebase.authWithCustomToken", 2, 3, arguments.length);
        kg("Firebase.authWithCustomToken", a);
        A("Firebase.authWithCustomToken", 2, b, !1);
        ng("Firebase.authWithCustomToken", 3, c, !0);
        Yg(this.k.M, a, {}, c || {}, b);
      };
      U.prototype.authWithCustomToken = U.prototype.Zf;
      U.prototype.$f = function(a, b, c) {
        x("Firebase.authWithOAuthPopup", 2, 3, arguments.length);
        mg("Firebase.authWithOAuthPopup", a);
        A("Firebase.authWithOAuthPopup", 2, b, !1);
        ng("Firebase.authWithOAuthPopup", 3, c, !0);
        ch(this.k.M, a, c, b);
      };
      U.prototype.authWithOAuthPopup = U.prototype.$f;
      U.prototype.ag = function(a, b, c) {
        x("Firebase.authWithOAuthRedirect", 2, 3, arguments.length);
        mg("Firebase.authWithOAuthRedirect", a);
        A("Firebase.authWithOAuthRedirect", 2, b, !1);
        ng("Firebase.authWithOAuthRedirect", 3, c, !0);
        var d = this.k.M;
        ah(d);
        var e = [Kg],
            f = vg(c);
        "anonymous" === a || "firebase" === a ? P(b, Mg("TRANSPORT_UNAVAILABLE")) : (yc.set("redirect_client_options", f.od), bh(d, e, "/auth/" + a, f, b));
      };
      U.prototype.authWithOAuthRedirect = U.prototype.ag;
      U.prototype.bg = function(a, b, c, d) {
        x("Firebase.authWithOAuthToken", 3, 4, arguments.length);
        mg("Firebase.authWithOAuthToken", a);
        A("Firebase.authWithOAuthToken", 3, c, !1);
        ng("Firebase.authWithOAuthToken", 4, d, !0);
        p(b) ? (lg("Firebase.authWithOAuthToken", 2, b), $g(this.k.M, a + "/token", {access_token: b}, d, c)) : (ng("Firebase.authWithOAuthToken", 2, b, !1), $g(this.k.M, a + "/token", b, d, c));
      };
      U.prototype.authWithOAuthToken = U.prototype.bg;
      U.prototype.Yf = function(a, b) {
        x("Firebase.authAnonymously", 1, 2, arguments.length);
        A("Firebase.authAnonymously", 1, a, !1);
        ng("Firebase.authAnonymously", 2, b, !0);
        $g(this.k.M, "anonymous", {}, b, a);
      };
      U.prototype.authAnonymously = U.prototype.Yf;
      U.prototype.cg = function(a, b, c) {
        x("Firebase.authWithPassword", 2, 3, arguments.length);
        ng("Firebase.authWithPassword", 1, a, !1);
        og("Firebase.authWithPassword", a, "email");
        og("Firebase.authWithPassword", a, "password");
        A("Firebase.authWithPassword", 2, b, !1);
        ng("Firebase.authWithPassword", 3, c, !0);
        $g(this.k.M, "password", a, c, b);
      };
      U.prototype.authWithPassword = U.prototype.cg;
      U.prototype.se = function(a, b) {
        x("Firebase.createUser", 2, 2, arguments.length);
        ng("Firebase.createUser", 1, a, !1);
        og("Firebase.createUser", a, "email");
        og("Firebase.createUser", a, "password");
        A("Firebase.createUser", 2, b, !1);
        this.k.M.se(a, b);
      };
      U.prototype.createUser = U.prototype.se;
      U.prototype.Te = function(a, b) {
        x("Firebase.removeUser", 2, 2, arguments.length);
        ng("Firebase.removeUser", 1, a, !1);
        og("Firebase.removeUser", a, "email");
        og("Firebase.removeUser", a, "password");
        A("Firebase.removeUser", 2, b, !1);
        this.k.M.Te(a, b);
      };
      U.prototype.removeUser = U.prototype.Te;
      U.prototype.pe = function(a, b) {
        x("Firebase.changePassword", 2, 2, arguments.length);
        ng("Firebase.changePassword", 1, a, !1);
        og("Firebase.changePassword", a, "email");
        og("Firebase.changePassword", a, "oldPassword");
        og("Firebase.changePassword", a, "newPassword");
        A("Firebase.changePassword", 2, b, !1);
        this.k.M.pe(a, b);
      };
      U.prototype.changePassword = U.prototype.pe;
      U.prototype.oe = function(a, b) {
        x("Firebase.changeEmail", 2, 2, arguments.length);
        ng("Firebase.changeEmail", 1, a, !1);
        og("Firebase.changeEmail", a, "oldEmail");
        og("Firebase.changeEmail", a, "newEmail");
        og("Firebase.changeEmail", a, "password");
        A("Firebase.changeEmail", 2, b, !1);
        this.k.M.oe(a, b);
      };
      U.prototype.changeEmail = U.prototype.oe;
      U.prototype.Ve = function(a, b) {
        x("Firebase.resetPassword", 2, 2, arguments.length);
        ng("Firebase.resetPassword", 1, a, !1);
        og("Firebase.resetPassword", a, "email");
        A("Firebase.resetPassword", 2, b, !1);
        this.k.M.Ve(a, b);
      };
      U.prototype.resetPassword = U.prototype.Ve;
    })();
    module.exports = Firebase;
  })($__require('3a').Buffer);
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("104", ["103"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = $__require('103');
  global.define = __define;
  return module.exports;
});

$__System.register("105", [], function(exports_1) {
    return {
        setters:[],
        execute: function() {
            exports_1("default",fbCollections = {
                reviews: function (baseUrl) {
                    var ref = new Firebase(baseUrl);
                    return new Firebase.util.NormalizedCollection(ref.child('reviews'), [ref.child('users').child('public'), 'user', 'reviews.userId'], [ref.child('products'), 'product', 'reviews.productId']).select('reviews.reviews', 'reviews.userId', 'user.firstName', 'user.lastName', 'reviews.productId', { key: 'product.name', alias: 'productName' }).ref();
                }
            });
        }
    }
});

$__System.register("106", ["f9", "104", "105"], function(exports_1) {
    var __extends = (this && this.__extends) || function (d, b) {
        for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p];
        function __() { this.constructor = d; }
        d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
    };
    var rxjs_1, firebase_1, firebase_collections_1;
    var RxFire;
    return {
        setters:[
            function (rxjs_1_1) {
                rxjs_1 = rxjs_1_1;
            },
            function (firebase_1_1) {
                firebase_1 = firebase_1_1;
            },
            function (firebase_collections_1_1) {
                firebase_collections_1 = firebase_collections_1_1;
            }],
        execute: function() {
            RxFire = (function (_super) {
                __extends(RxFire, _super);
                function RxFire(opts) {
                    this.initialItems = [];
                    this.newItems = new rxjs_1.default.Subject();
                    this.list = new rxjs_1.default.ReplaySubject(1);
                    this.updates = new rxjs_1.default.Subject();
                    this.create = new rxjs_1.default.Subject();
                    var ref = opts && (opts.ref || opts.fbRef) ||
                        typeof opts === 'string' && opts || this.base;
                    var onChildAdded = opts && opts.initChildAdded || true;
                    var normalized = opts && opts.normalized || false;
                    var onValue = opts && opts.onValue || false;
                    var orderByChild = opts && opts.orderByChild || false;
                    var equalTo = opts && opts.equalTo || false;
                    ref = ref.includes('firebaseio.com') ? ref : this.base + '/' + ref;
                    _super.call(this, ref);
                    this.ref = normalized ? this.normalizedCollection(normalized) : this;
                    if (onValue) {
                        this.onValue();
                    }
                    else if (onChildAdded && !onValue) {
                        this.onChildAdded();
                    }
                }
                RxFire.setBase = function (baseUrl) {
                    RxFire.prototype.base = baseUrl;
                };
                RxFire.prototype.onValue = function () {
                    var _this = this;
                    this.ref.on('value', function (snap) { return _this.list.next(snap.val()); });
                };
                RxFire.prototype.onChildAdded = function () {
                    var _this = this;
                    this.updates
                        .scan(function (childAdded, operation) { return operation(childAdded); }, this.initialItems)
                        .subscribe(this.list);
                    this.create
                        .map(function (item) { return function (childAdded) { return childAdded.concat(item); }; })
                        .subscribe(this.updates);
                    this.newItems
                        .subscribe(this.create);
                    this.ref.on('child_added', function (snap) { return _this.newItems.next(snap.val()); });
                };
                RxFire.prototype.normalizedCollection = function (collectionId) {
                    return firebase_collections_1.default[collectionId](this.base);
                };
                return RxFire;
            })(firebase_1.default);
            exports_1("default", RxFire);
        }
    }
});

$__System.register("1", ["106"], function(exports_1) {
    return {
        setters:[
            function (rxfire_1_1) {
                exports_1({
                    "RxFire": rxfire_1_1["default"]
                });
            }],
        execute: function() {
        }
    }
});

})
(function(factory) {
  module.exports = factory();
});
//# sourceMappingURL=rxfire.js.map