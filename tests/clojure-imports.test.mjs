// Clojure: a require names a namespace, not a path, so the file that answers it is the one whose (ns …) says so.
// These tests scan whole little projects, the way a real one is scanned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { makeProject, run, readJson, cleanup } from './helpers.mjs';

/** Scans `files` and returns its edges as "from -> to", its externals, and the scan's import counts. */
function scan(files) {
  const root = makeProject(files, { repos: ['.'] });
  try {
    const out = run('scan.mjs', root);
    const s = readJson(path.join(root, 'floorplan', '.cache', 'scan.json'));
    const counts = /IMPORT EDGES\s+(\d+) file->file resolved, (\d+) unresolved/.exec(out);
    return {
      edges: s.edges.map((e) => `${e.from} -> ${e.to}`).sort(),
      dynamic: s.edges.filter((e) => e.dynamic).map((e) => `${e.from} -> ${e.to}`).sort(),
      externals: s.externals.map((e) => e.id).sort(),
      resolved: Number(counts?.[1]),
      unresolved: Number(counts?.[2]),
    };
  } finally { cleanup(root); }
}

const CORE = [
  '(ns app.core',
  '  "The start of it."',
  '  (:require [app.util :as util]',
  '            [app.thing-helper :as helper]',
  '            [clojure.string :as str]))',
  '',
  '(defn run [x] (util/hi (helper/x x)))',
].join('\n');

test('Clojure: a require reaches the file whose ns form declares that namespace', () => {
  const r = scan({
    'src/app/core.clj': CORE,
    'src/app/util.clj': '(ns app.util)\n\n(defn hi [n] (str "hi " n))\n',
    // the file's name has nothing to do with its namespace, and the ns has a dash in it
    'src/app/helper.clj': '(ns app.thing-helper)\n\n(defn x [n] n)\n',
  });
  assert.deepEqual(r.edges, ['src/app/core.clj -> src/app/helper.clj', 'src/app/core.clj -> src/app/util.clj']);
  assert.deepEqual(r.externals, [], 'clojure.string comes with Clojure, so it is not a library to install');
  assert.equal(r.unresolved, 0);
});

test('Clojure: a namespace reached with requiring-resolve or resolve is a real dependency', () => {
  const r = scan({
    'src/app/chat.clj': [
      '(ns app.chat)',
      '',
      "(defn prompt [] ((requiring-resolve 'app.prompts/build) 1))",
      "(defn store [] (resolve 'app.db/save))",
    ].join('\n'),
    'src/app/prompts.clj': '(ns app.prompts)\n\n(defn build [] 1)\n',
    'src/app/db.clj': '(ns app.db)\n\n(defn save [] 1)\n',
  });
  assert.deepEqual(r.edges, ['src/app/chat.clj -> src/app/db.clj', 'src/app/chat.clj -> src/app/prompts.clj']);
  assert.deepEqual(r.dynamic, ['src/app/chat.clj -> src/app/db.clj', 'src/app/chat.clj -> src/app/prompts.clj']);
});

test('Clojure: one namespace in several files links the one the reader can use, .cljc for both', () => {
  const r = scan({
    // the same namespace in three dialects: a .clj file can't read a .cljs one
    'src/app/dup.clj': '(ns app.dup)\n\n(defn where [] :clj)\n',
    'src/app/dup.cljs': '(ns app.dup)\n\n(defn where [] :cljs)\n',
    'src/app/dup.cljc': '(ns app.dup)\n\n(defn where [] :both)\n',
    'src/app/server.clj': '(ns app.server (:require [app.dup :as dup]))\n',
    'src/app/ui.cljs': '(ns app.ui (:require [app.dup :as dup]))\n',
    // a .cljc file reads .cljc first, and a .cljs require is a package from node_modules, not this project
    'src/app/shared.cljc': '(ns app.shared (:require [app.dup :as dup] ["react" :as react]))\n',
  });
  assert.deepEqual(r.edges, [
    'src/app/server.clj -> src/app/dup.clj',
    'src/app/shared.cljc -> src/app/dup.cljc',
    'src/app/ui.cljs -> src/app/dup.cljs',
  ]);
  assert.deepEqual(r.externals, ['npm:react']);
});

test('Clojure: tests see the code they test, and no src file reaches into a test', () => {
  const r = scan({
    'src/app/core.clj': CORE,
    'src/app/util.clj': '(ns app.util)\n\n(defn hi [n] n)\n',
    'src/app/helper.clj': '(ns app.thing-helper)\n\n(defn x [n] n)\n',
    'test/app/core_test.clj': '(ns app.core-test (:require [app.core :as core] [app.test-helper :as h]))\n',
    'test/app/test_helper.clj': '(ns app.test-helper)\n\n(defn setup [] 1)\n',
    // a src file asking for a test's own namespace: nothing to link, and counted as unresolved rather than a library
    'src/app/leaky.clj': '(ns app.leaky (:require [app.test-helper :as h]))\n',
  });
  assert.deepEqual(r.edges, [
    'src/app/core.clj -> src/app/helper.clj',
    'src/app/core.clj -> src/app/util.clj',
    'test/app/core_test.clj -> src/app/core.clj',
    'test/app/core_test.clj -> test/app/test_helper.clj',
  ]);
  assert.equal(r.unresolved, 1);
  assert.deepEqual(r.externals, []);
});

test('Clojure: a library is an outside package, and Clojure and Java themselves are not', () => {
  const r = scan({
    'src/app/lib_use.clj': [
      '(ns app.lib-use',
      '  (:require [cheshire.core :as json]',
      '            [ring.util.response :as resp]',
      '            [clojure.string :as str]',
      '            [clojure.core.async :as a])',
      '  (:import [java.util UUID]))',
      '',
      '(defn go [] (json/generate-string (UUID/randomUUID)))',
    ].join('\n'),
    'src/app/missing.clj': '(ns app.missing (:require [app.nonexistent :as n]))\n',
    'src/app/lib_use2.clj': '(ns app.lib-use2 (:require [cheshire.generate :as gen]))\n',
  });
  // cheshire.core and cheshire.generate are one library; ring.util.response is ring; core.async is its own library
  assert.deepEqual(r.externals, ['clojars:cheshire', 'clojars:clojure.core.async', 'clojars:ring']);
  assert.equal(r.unresolved, 1, 'a namespace in the project\'s own family that no file declares is counted, not called a library');
});

test('Clojure: an :import of a class from this project links to the Java file that declares it', () => {
  const r = scan({
    'src/app/gadget.clj': [
      '(ns app.gadget',
      '  (:import [com.example.widget Gadget Gadget$Factory]', // an inner class is the file of the class around it
      '           java.time.Instant))',
      '',
      '(defn make [] (Gadget.))',
    ].join('\n'),
    'src/main/java/com/example/widget/Gadget.java': 'package com.example.widget;\n\npublic class Gadget {\n  public static class Factory {}\n}\n',
  });
  assert.deepEqual(r.edges, ['src/app/gadget.clj -> src/main/java/com/example/widget/Gadget.java']);
  assert.deepEqual(r.externals, [], 'java.time.Instant is part of the JDK');
  assert.equal(r.unresolved, 0);
});
