/**
 * @file Replaces `goog.exportProperty` calls with `@export` if possible, falling back to an assignment
 *               expression.
 */

const jscs = require('jscodeshift');
const get = require('get-value');

/**
 * Regular expression to remove placeholder comment for removed statements.
 * @type {RegExp}
 * @const
 */
const REMOVE_REGEXP = /\/\*JSCS-REMOVE\*\/;\n/g;

/**
 * Filter object for matching a `goog.exportProperty` CallExpression node.
 * @type {Object}
 */
const googExportPropertyFilter = {
  callee: {
    object: {name: 'goog'},
    property: {name: 'exportProperty'}
  }
};

/**
 * If a node is a `goog.exportProperty` call.
 * @param {Node} node The node.
 * @return {boolean}
 */
const isGEPCall = node => {
  return node.type === 'CallExpression' && jscs.match(node, googExportPropertyFilter);
};

/**
 * If a node is a `goog.exportProperty` call that can be replaced by `@export`.
 * @param {Node} node The node.
 * @return {boolean}
 */
const isExportableCall = node => {
  if (isGEPCall(node) && get(node, 'arguments.0.property.name') === 'prototype') {
    const exportName = get(node.arguments[1].value);
    const fnName = get(node.arguments[2].property.name);
    return exportName && fnName && (exportName == fnName || `${exportName}_` == fnName);
  }

  return false;
};

/**
 * Strip the trailing underscore from a private function name.
 * @param {Node} root The root node.
 * @param {string} name The function name.
 * @return {string} The new functio name;
 */
const renamePrivateFn = (root, name) => {
  const newName = name.replace(/_$/, '');

  if (newName !== name) {
    root.find(jscs.MemberExpression, {
      object: {type: 'ThisExpression'},
      property: {name: name}
    }).forEach(path => path.value.property.name = newName);
  }

  return newName;
};

/**
 * Replace a CallExpression with a BinaryExpression.
 * @param {File} file The file being processed.
 * @param {Object} api The jscodeshift API.
 * @param {Object} options The jscodeshift options.
 */
module.exports = (file, api, options) => {
  const root = jscs(file.source);

  root.find(jscs.CallExpression, isExportableCall).forEach(path => {
    if (get(path.parent.parent.value.type) === 'Program') {
      const programBody = get(path.parent.parent.value.body);
      const currentIndex = programBody ? programBody.indexOf(path.parent.value) : -1;
      const prev = currentIndex > 0 ? programBody[currentIndex - 1] : undefined;

      if (prev && prev.type === 'ExpressionStatement' && get(prev.comments.length) > 0) {
        if (prev.comments[prev.comments.length - 1].type === 'CommentBlock') {
          // remove the old comment before updating
          let newComment = prev.comments.pop().value;

          // add @export to comment block unless already present
          if (!newComment.includes('@export')) {
            newComment = newComment.replace(/\s+$/, '\n * @export\n ');
          }

          // remove @protected annotation
          newComment = newComment.replace('\n * @protected', '');

          // if the function is marked as private, make it public
          if (newComment.includes('@private')) {
            prev.expression.left.property.name = renamePrivateFn(root, prev.expression.left.property.name);
            newComment = newComment.replace('\n * @private', '');
          }

          // add the updated comment
          prev.comments.push(jscs.commentBlock(newComment));

          // remove the expression
          // WORKAROUND: A recast bug may cause this to drop all blank lines after the statement. As a workaround,
          // replace the statement with a comment block and remove it later.
          jscs(path).replaceWith(jscs.commentBlock('JSCS-REMOVE'));
        }
      }
    }
  });

  root.find(jscs.CallExpression, isGEPCall).forEach(path => {
    // replace the expression with an assignment
    const leftSide = jscs.memberExpression(path.node.arguments[0], path.node.arguments[1]);
    jscs(path).replaceWith(pp => jscs.assignmentExpression('=', leftSide, path.node.arguments[2]));
  });

  return root.toSource().replace(REMOVE_REGEXP, '');
};
