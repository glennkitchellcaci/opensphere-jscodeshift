const callToBinary = require('../scripts/calltobinary');

module.exports = (file, api, options) => {
  const root = callToBinary(file, api, {
    callee: {
      object: {name: 'goog'},
      property: {name: 'isDef'}
    }
  }, {
    expression: '!==',
    notExpression: '===',
    rightSide: api.jscodeshift.identifier('undefined')
  });

  // print
  return root.toSource();
};
