// Clojure: a file's namespace, the namespaces and classes it reaches for, and the docstrings that live inside
// its forms (after the ns name, after a def's name) rather than above them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lib } from './helpers.mjs';

const { extract } = await lib('extract.mjs');

const clj = (src, file = 'src/app/core.clj') => extract(src, 'clojure', file);
const specs = (r) => r.imports.map((i) => i.spec);
const names = (r) => r.symbols.map((s) => s.name);

test('Clojure: a require by bare name, by vector, and by prefix list', () => {
  const r = clj([
    '(ns app.core',
    '  (:require [clojure.string :as string]',
    '            cheshire.core',
    '            (app.features [chat :as chat] [tools :as tools])',
    '            [app.config :as config :refer [defaults load?]]))',
  ].join('\n'));
  assert.equal(r.ns, 'app.core');
  assert.deepEqual(specs(r), ['clojure.string', 'cheshire.core', 'app.features.chat', 'app.features.tools', 'app.config']);
  const config = r.imports.find((i) => i.spec === 'app.config');
  assert.deepEqual(config.names, ['defaults', 'load?'], 'the names a :refer hands the file');
  assert.equal(config.line, 5, 'the line the require is written on');
});

test('Clojure: :use, :refer :all and every shape of :import', () => {
  const r = clj([
    '(ns app.java',
    '  (:use [old.helpers :only [a b]])',
    '  (:require [everything.lib :refer :all])',
    '  (:import (java.io File Writer)',
    '           [java.net Proxy$Type]',
    '           java.time.Instant))',
  ].join('\n'));
  assert.deepEqual(specs(r), ['old.helpers', 'everything.lib', 'java.io.File', 'java.io.Writer', 'java.net.Proxy', 'java.time.Instant']);
  assert.deepEqual(r.imports.find((i) => i.spec === 'old.helpers').names, ['a', 'b']);
  assert.deepEqual(r.imports.find((i) => i.spec === 'everything.lib').names, ['*']);
  assert.deepEqual(r.imports.filter((i) => i.kind === 'class').map((i) => i.spec), ['java.io.File', 'java.io.Writer', 'java.net.Proxy', 'java.time.Instant']);
});

test("ClojureScript: a string require is a package from node_modules, not a namespace", () => {
  const r = clj('(ns app.ui (:require ["react" :as react :refer [useState]]))', 'src/app/ui.cljs');
  assert.deepEqual(r.imports, [{ spec: 'react', names: ['useState'], kind: 'package', line: 1 }]);
});

test('Clojure: a .cljc file is read for both targets, so both branches of a reader conditional count', () => {
  const r = clj([
    '(ns app.shared',
    '  (:require #?(:clj [clojure.java.io :as io]',
    '               :cljs [cljs.reader :as reader])))',
    '#?(:clj (defn file-of [x] x)',
    '   :cljs (defn file-of [y] y))',
  ].join('\n'), 'src/app/shared.cljc');
  assert.deepEqual(specs(r), ['clojure.java.io', 'cljs.reader']);
  assert.deepEqual(names(r), ['file-of', 'file-of'], 'a def in either branch is a def');
});

test('Clojure: ; comments, #_ discards and (comment …) blocks hold no code', () => {
  const r = clj([
    '(ns app.quiet (:require [kept.ns :as k] #_[gone.ns :as g]))',
    ';; (require (quote [commented.out :as c]))',
    '#_(require (quote [discarded.ns :as d]))',
    '#_#_[dropped.one :as d1] [dropped.two :as d2]',
    '(comment',
    '  (:require [never.loaded :as n])',
    '  (defn not-real [] 1))',
    '#_(defn ghost [] 1)',
    '(defn real [] 1)',
  ].join('\n'));
  assert.deepEqual(specs(r), ['kept.ns']);
  assert.deepEqual(names(r), ['real']);
});

test('Clojure: brackets inside strings, character literals and regexes are text, not code', () => {
  const r = clj([
    '(ns app.text)',
    '(def open \\()',
    '(def close \\))',
    '(def semi \\;)',
    '(def message "a ) with ( and \\" in it")',
    '(def pattern #"[(]x[)]")',
    '(defn after [x] x)',
  ].join('\n'));
  assert.deepEqual(names(r), ['open', 'close', 'semi', 'message', 'pattern', 'after']);
});

test('Clojure: the ns docstring describes the file, and a def docstring describes what it names', () => {
  const r = clj([
    '(ns ^:no-doc app.loader',
    '  "Loads modules: Clojure code read with SCI, in one context shared by all of them."',
    '  {:author "someone"}',
    '  (:require [babashka.fs :as fs]))',
    '(defn ^:private exit',
    '  "Leaves with a status."',
    '  [status] status)',
    '(defn public-thing "Does a thing." [x] x)',
    '(def helper "The helper." (fn [x] x))',
    '(def plain "just a value")',
  ].join('\n'));
  assert.equal(r.ns, 'app.loader');
  assert.equal(r.doc, 'Loads modules: Clojure code read with SCI, in one context shared by all of them.');
  const doc = (name) => r.symbols.find((s) => s.name === name).doc;
  assert.equal(doc('exit'), 'Leaves with a status.');
  assert.equal(doc('public-thing'), 'Does a thing.');
  assert.equal(doc('helper'), 'The helper.');
  assert.equal(doc('plain'), undefined, '(def name "value") is a value, not a docstring');
});

test("Clojure: private defs are the file's own, so nothing outside it lists them", () => {
  const r = clj([
    '(ns app.api)',
    '(defn- hidden [] 1)',
    '(defn ^:private hidden-too [] 2)',
    '(def ^:private ^{:private true} secret 3)',
    '(defn ^{:private true :doc "Still private."} documented-private [] 4)',
    '(defn public-one [] 5)',
    '(defmulti handle :type)',
    '(defmethod handle :a [x] x)',
    '(defrecord Thing [a])',
    '(defprotocol Proto (go [x]))',
    '(defmacro with-x [& body] body)',
  ].join('\n'));
  assert.deepEqual(r.symbols.map((s) => [s.name, s.kind, !!s.priv]), [
    ['hidden', 'function', true], ['hidden-too', 'function', true], ['secret', 'val', true],
    ['documented-private', 'function', true], ['public-one', 'function', false],
    ['handle', 'function', false], ['handle', 'function', false], ['Thing', 'class', false],
    ['Proto', 'class', false], ['with-x', 'function', false],
  ]);
  assert.equal(r.symbols.length, 5 + 5);
  assert.deepEqual(r.decls, ['public-one', 'handle', 'Thing', 'Proto', 'with-x']);
});

test('Clojure: a namespace loaded when it is needed is a real dependency', () => {
  const r = clj([
    '(ns app.chat)',
    "(defn prompt [] ((requiring-resolve 'app.features.chat/prompt) 1))",
    "(defn stored [] (resolve (quote app.store/fetch)))",
    "(defn core-var [] (resolve 'inc))",
  ].join('\n'));
  assert.deepEqual(specs(r), ['app.features.chat', 'app.store'], '(resolve \'inc) asks about a core var, not a file');
});

test('Clojure: :as-alias names a namespace it never loads, and is kept as such', () => {
  const r = clj('(ns app.specs (:require [app.spec :as-alias spec :as s]))');
  assert.deepEqual(r.imports, [{ spec: 'app.spec', names: [], line: 1, aliasOnly: true }]);
});

test('Clojure: the same namespace required twice is one edge, with the names from both', () => {
  const r = clj([
    '(ns app.twice (:require [other.lib :refer [a]]))',
    "(require '[other.lib :as o :refer [b]])",
  ].join('\n'));
  assert.deepEqual(r.imports, [{ spec: 'other.lib', names: ['a', 'b'], line: 1 }]);
});

test('Clojure files built to make pattern matching slow are read quickly', () => {
  const mb = (unit) => unit.repeat(Math.ceil((2 * 1024 * 1024) / unit.length));
  const cases = {
    'unclosed strings': mb('(def s "x\\'),
    'unclosed brackets': mb('(((((('),
    'unclosed (comment blocks': mb('(comment [ (unclosed\n'),
    'discard runs': mb('#_#_#_ (a b c '),
    'metadata runs': mb('^:private ^:private ^:private f '),
    'a bracket in every comment': mb('; ) ( "#_ \n(defn f [] 1)\n'),
    'unclosed regexes': mb('#"x'),
  };
  for (const [name, src] of Object.entries(cases)) {
    const started = performance.now();
    extract(src, 'clojure', 'src/slow.clj');
    const ms = performance.now() - started;
    assert.ok(ms < 2000, `${name} took ${Math.round(ms)} ms`);
  }
});
