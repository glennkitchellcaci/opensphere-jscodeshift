const jscs = require('jscodeshift');
const {getClassNode, registerClassNode} = require('./classregistry');
const {addExports} = require('./es6');
const {addLegacyNamespace, isControllerClass, isPrivate} = require('./goog');
const {createCall, createFindCallFn, createFindMemberExprObject, memberExpressionToString} = require('./jscs');
const {logger} = require('./logger');

/**
 * Match comments that should be put in the constructor function.
 * @type {RegExp}
 */
const CTOR_COMMENT_REGEXP = /@ngInject/;

/**
 * Match comments that should be put in the constructor function.
 * @type {RegExp}
 */
const COMMENT_IGNORE_REGEXP = /@constructor/;

/**
 * Match @extends JSDoc.
 * @type {RegExp}
 */
const EXTENDS = /@extends/;

/**
 * Match @extends JSDoc with a generic type provided.
 * @type {RegExp}
 */
const EXTENDS_GENERIC = /@extends {.+<.+>}/;

/**
 * Property name to assign UI controller class.
 * @type {string}
 */
const CONTROLLER_NAME = 'Controller';

/**
 * Property name to assign directive functions.
 * @type {string}
 */
const DIRECTIVE_NAME = 'directive';

/**
 * Adds a method to a class.
 */
const addMethodToClass = (moduleName, methodName, methodValue, isStatic) => {
  let classMethod;

  const classDef = getClassNode(moduleName);
  if (classDef) {
    classMethod = jscs.methodDefinition('method', jscs.identifier(methodName), methodValue, isStatic);
    classDef.body.body.push(classMethod);
  }

  return classMethod;
};

/**
 * Move a static class property to a static get function.
 * @param {NodePath} path Path to the property assignment node.
 * @param {string} moduleName The class module name.
 */
const addStaticGetToClass = (path, moduleName) => {
  const classDef = getClassNode(moduleName);
  if (classDef) {
    const propertyName = path.value.left.property.name;

    const getBlock = jscs.blockStatement([jscs.returnStatement(path.value.right)]);
    const getFn = jscs.functionExpression(null, [], getBlock);
    const staticGet = jscs.methodDefinition('get', jscs.identifier(propertyName), getFn, true);

    if (path.parent.value.comments && path.parent.value.comments.length) {
      const newComment = path.parent.value.comments[0].value.replace('\n * @const', '');
      staticGet.comments = [jscs.commentBlock(newComment)];
    }

    classDef.body.body.push(staticGet);

    jscs(path).remove();
  }
};

/**
 * Clean up comment block parts before generating the block.
 * @param {Array<string>} commentParts The comment parts.
 */
const createCommentBlockFromParts = (commentParts) => {
  // remove leading/trailing blank comment lines
  while (commentParts.length && (!commentParts[0] || commentParts[0].trim() === '*')) {
    commentParts.shift();
  }

  while (commentParts.length && (!commentParts[commentParts.length - 1] || commentParts[commentParts.length - 1].trim() === '*')) {
    commentParts.pop();
  }

  // default comment block is /*, this makes it /**
  commentParts.unshift('*');

  // indent */ by one space
  commentParts.push(' ');

  return commentParts.join('\n');
};

/**
 * Split a comment into parts for the class and constructor.
 * @param {string} comment The original class comment.
 * @return {{classComment: string, ctorComment: string}}
 */
const splitCommentsForClass = (comment) => {
  const origParts = comment.trim().split('\n');
  const classCommentParts = [];
  const ctorCommentParts = [' * Constructor.'];

  let inParam = false;
  for (let i = 0; i < origParts.length; i++) {
    const part = origParts[i];
    const trimmed = part.trim();

    if (inParam && !trimmed.startsWith('*   ')) {
      // assume multi-line params are indented at least two extra spaces
      inParam = false;
    }

    if (COMMENT_IGNORE_REGEXP.test(trimmed)) {
      // drop blacklisted comment
      continue;
    } else if (EXTENDS.test(trimmed) && !EXTENDS_GENERIC.test(trimmed)) {
      // drop @extends unless it provides a generic type
      continue;
    } else if (trimmed.startsWith('* @param') || inParam) {
      ctorCommentParts.push(part);
      inParam = true;
    } else if (CTOR_COMMENT_REGEXP.test(trimmed)) {
      ctorCommentParts.push(part);
    } else {
      classCommentParts.push(part);
    }
  }

  return {
    body: createCommentBlockFromParts(classCommentParts),
    ctor: createCommentBlockFromParts(ctorCommentParts)
  };
};

/**
 * Insert the node prior to the named class declaration.
 */
const insertBeforeClass = (root, className, node) => {
  root.find(jscs.ClassDeclaration, {id: {name: className}}).forEach(path => {
    jscs(path).insertBefore(node);
  });
};

/**
 * Convert an Angular directive function.
 */
const convertDirective = (root, path, moduleName) => {
  const directiveFn = jscs.arrowFunctionExpression([], path.value.right.body, false);
  const varDeclarator = jscs.variableDeclarator(jscs.identifier(DIRECTIVE_NAME), directiveFn);
  const varDeclaration = jscs.variableDeclaration('const', [varDeclarator]);
  varDeclaration.comments = [jscs.commentBlock(path.parent.value.comments.pop().value)];

  jscs(path.parent).replaceWith(varDeclaration);

  // replace references to the fully qualified class name with the local class reference
  root.find(jscs.MemberExpression, createFindMemberExprObject(moduleName))
      .forEach(path => jscs(path).replaceWith(jscs.identifier(DIRECTIVE_NAME)));

  addExports(root, path.parent.parent.value, [DIRECTIVE_NAME]);
};

/**
 * Convert a private static property on the class to a local variable.
 */
const convertPrivateClassPropertyToConst = (root, path, moduleName) => {
  const propertyName = path.value.left.property.name;
  const varDeclarator = jscs.variableDeclarator(jscs.identifier(propertyName), path.value.right);
  const varDeclaration = jscs.variableDeclaration('const', [varDeclarator]);

  const newComment = path.parent.value.comments.pop().value.split('\n')
      .filter(comment => !(/^\* @(private|const)$/.test(comment.trim())))
      .join('\n');

  varDeclaration.comments = [jscs.commentBlock(newComment)];

  const classDef = getClassNode(moduleName);
  if (classDef) {
    if (jscs(varDeclarator).find(jscs.MemberExpression, createFindMemberExprObject(moduleName)).length) {
      // references the class, move to the end of the file
      const program = root.find(jscs.Program).get();
      if (program) {
        program.value.body.push(varDeclaration);
        jscs(path.parent).remove();
      }
    } else {
      // move prior to the class definition
      insertBeforeClass(root, classDef.id.name, varDeclaration);
      jscs(path.parent).remove();
    }
  } else {
    // replace in the same position
    jscs(path.parent).replaceWith(varDeclaration);
  }

  // replace local references to the expression
  root.find(jscs.MemberExpression, createFindMemberExprObject(`${moduleName}.${propertyName}`)).forEach(path => {
    jscs(path).replaceWith(jscs.identifier(propertyName));
  });
};

/**
 * Adds a method to a class.
 */
const convertStaticProperty = (root, path, moduleName) => {
  if (path.value.right.type === 'FunctionExpression') {
    const classMethod = addMethodToClass(moduleName, path.value.left.property.name, path.value.right, true);
    classMethod.comments = path.parent.value.comments;

    jscs(path).remove();
  } else if (isPrivate(path.parent.value)) {
    convertPrivateClassPropertyToConst(root, path, moduleName);
  } else {
    addStaticGetToClass(path, moduleName);
  }
};

const convertPrototypeExpression = (path, moduleName) => {
  const propertyName = path.value.left.property.name;
  const valueType = path.value.right.type;
  if (valueType === 'FunctionExpression') {
    // move functions to the class
    const classMethod = addMethodToClass(moduleName, propertyName, path.value.right, false);
    classMethod.comments = path.parent.value.comments;

    jscs(path).remove();
  } else if (valueType === 'MemberExpression') {
    // convert in place, replacing the module name with the class name (ClassName.prototype.propertyName = value)
    replaceFQClass(path.value.left.object, moduleName);
  } else {
    logger.warn(`In ${moduleName}: Unable to convert prototype expression ${propertyName} of type ${valueType}.`);
  }
};

/**
 * Move a `goog.inherits` expression to the class extends syntax.
 * @param {NodePath} path Path to the goog.inherits expression.
 * @param {string} moduleName The module name.
 */
const moveInheritsToClass = (path, moduleName) => {
  const classDef = getClassNode(moduleName);
  if (classDef) {
    classDef.superClass = path.value.arguments[1];
    jscs(path).remove();
  }
};

/**
 * Replace a fully-qualified class member expression with the class name, for local references.
 * @param {Node} node The member expression.
 * @param {string} moduleName The module name.
 */
const replaceFQClass = (node, moduleName) => {
  const classDef = getClassNode(moduleName);
  if (classDef) {
    node.object = jscs.identifier(classDef.id.name);
  }
};

/**
 * Move a `goog.addSingletonInstance` call to a static get on the class.
 * @param {NodePath} path The path.
 * @param {string} moduleName The module name.
 */
const moveSingletonToClass = (path, moduleName) => {
  const classDef = getClassNode(moduleName);
  if (classDef) {
    const className = classDef.id.name;
    const newExpression = jscs.newExpression(jscs.identifier(className), []);
    const varDeclarator = jscs.variableDeclarator(jscs.identifier('instance'), newExpression);
    const varDeclaration = jscs.variableDeclaration('const', [varDeclarator]);
    const instanceComment = ['*', ` * Global ${className} instance.`, ` * @type {${className}}`, ' '].join('\n');
    varDeclaration.comments = [jscs.commentBlock(instanceComment)];

    jscs(path.parent).replaceWith(varDeclaration);

    const getInstanceBlock = jscs.blockStatement([jscs.returnStatement(jscs.identifier('instance'))]);
    const getInstanceFn = jscs.functionExpression(null, [], getInstanceBlock);
    const classMethod = addMethodToClass(moduleName, 'getInstance', getInstanceFn, true);
    const getInstanceComments = ['*', ' * Get the global instance.', ` * @return {${className}}`, ' '].join('\n');
    classMethod.comments = [jscs.commentBlock(getInstanceComments)];
  }
};

const replaceBaseWithSuper = (path, moduleName) => {
  const args = path.value.arguments;
  if (args[1].type === 'Literal') {
    const fnName = args[1].value;
    const superArgs = args.slice(2);

    let superCall;
    if (fnName === 'constructor') {
      superCall = jscs.callExpression(jscs.super(), superArgs);
      // TODO: detect "this" before super and log a warning
    } else {
      const superMember = jscs.memberExpression(jscs.super(), jscs.identifier(fnName), false);
      superCall = jscs.callExpression(superMember, superArgs);
    }

    if (superCall) {
      jscs(path).replaceWith(superCall);
    }
  }
};

const replaceSuperclassWithSuper = (path, moduleName) => {
  // superClass_ -> fn -> "call" member -> call expression
  const callExpr = path.parent.parent.parent;
  const fnName = path.parent.value.property.name;
  const className = memberExpressionToString(path.value.object);
  if (className === moduleName) {
    // classes match, convert to super
    const superMember = jscs.memberExpression(jscs.super(), jscs.identifier(fnName), false);
    const superArgs = callExpr.value.arguments.slice(1);
    const superCall = jscs.callExpression(superMember, superArgs);
    jscs(callExpr).replaceWith(superCall);
  } else {
    logger.warn(`In ${moduleName}: Found superClass_ call to another class (${className}).`);
  }
};

/**
 * Replace all goog.provide statements with goog.module
 * @param {NodePath} root The root node.
 * @return {!Array<string>} List of modules in the file.
 */
const replaceProvidesWithModules = (root) => {
  const modules = [];
  const findFn = createFindCallFn('goog.provide');
  root.find(jscs.CallExpression, findFn).forEach((path, idx, paths) => {
    const args = path.value.arguments;
    modules.push(args[0].value);

    jscs(path).replaceWith(createCall('goog.module', args));

    if (!idx) {
      addLegacyNamespace(path.parent);
    }
  });

  return modules;
};

/**
 * Replace all goog.provide statements with goog.module
 * @param {NodePath} root The root node.
 * @param {string} controllerName The controller name.
 * @param {string} directiveName The directive name.
 */
const replaceUIModules = (root, controllerName, directiveName) => {
  const moduleName = controllerName.replace(/Ctrl$/, '');
  const findFn = createFindCallFn('goog.module');
  root.find(jscs.CallExpression, findFn).forEach((path, idx, paths) => {
    const args = path.value.arguments;
    if (args[0].value === directiveName) {
      jscs(path).remove();
    } else if (args[0].value === controllerName) {
      args[0] = jscs.literal(moduleName);
    }
  });
};

const convertClass = (root, path, moduleName) => {
  const isController = isControllerClass(path.parent.value);
  const className = isController ? CONTROLLER_NAME : path.value.left.property.name;

  const ctorFn = jscs.functionExpression(null, path.value.right.params, path.value.right.body);
  const ctor = jscs.methodDefinition('constructor', jscs.identifier('constructor'), ctorFn);
  const classBody = jscs.classBody([ctor]);
  const classDef = jscs.classDeclaration(jscs.identifier(className), classBody);

  const comments = path.parent.value.comments;
  if (comments && comments.length) {
    const classComments = splitCommentsForClass(comments.pop().value);
    if (isController) {
      classComments.body = classComments.body.replace(/ *$/, ' * @unrestricted\n ');
    }
    classDef.comments = [jscs.commentBlock(classComments.body)];
    ctor.comments = [jscs.commentBlock(classComments.ctor)];
  }

  jscs(path.parent).replaceWith(classDef);

  registerClassNode(moduleName, classDef);

  // move all prototype functions/properties to the class
  root.find(jscs.AssignmentExpression, {
    left: {
      type: 'MemberExpression',
      object: createFindMemberExprObject(`${moduleName}.prototype`)
    }
  }).forEach(path => convertPrototypeExpression(path, moduleName));

  // replace all <class>.base calls with super
  root.find(jscs.CallExpression, createFindCallFn(`${moduleName}.base`))
      .forEach(path => replaceBaseWithSuper(path, moduleName));

  // replace all <class>.superClass_ calls with super
  root.find(jscs.MemberExpression, createFindMemberExprObject(`superClass_`))
      .forEach(path => replaceSuperclassWithSuper(path, moduleName));

  // move all static properties to the class
  root.find(jscs.AssignmentExpression, {
    left: {
      type: 'MemberExpression',
      object: createFindMemberExprObject(moduleName)
    }
  }).forEach(path => convertStaticProperty(root, path, moduleName));

  // move goog.addSingletonGetter to a class getInstance function
  root.find(jscs.CallExpression, {
    callee: createFindMemberExprObject('goog.addSingletonGetter'),
    arguments: [createFindMemberExprObject(moduleName)]
  }).forEach(path => moveSingletonToClass(path, moduleName));

  // move goog.inherits to class extends keyword
  root.find(jscs.CallExpression, {
    callee: createFindMemberExprObject('goog.inherits'),
    arguments: [createFindMemberExprObject(moduleName)]
  }).forEach(path => moveInheritsToClass(path, moduleName));

  // replace references to the fully qualified class name with the local class reference
  root.find(jscs.MemberExpression, createFindMemberExprObject(moduleName))
      .forEach(path => jscs(path).replaceWith(jscs.identifier(className)))

  // add exports statement for the class
  addExports(root, path.parent.parent.value, isController ? [className] : className);
};

module.exports = {
  addMethodToClass,
  addStaticGetToClass,
  convertClass,
  convertDirective,
  replaceProvidesWithModules,
  replaceUIModules,
  splitCommentsForClass
};
