'use strict';

const defineTest = require('jscodeshift/dist/testUtils').defineTest;

defineTest(__dirname, 'bind', {});
defineTest(__dirname, 'exportproperty', {});
defineTest(__dirname, 'isboolean', {});
defineTest(__dirname, 'isdef', {});
defineTest(__dirname, 'isdefandnotnull', {});
defineTest(__dirname, 'isnull', {});
defineTest(__dirname, 'isnumber', {});
defineTest(__dirname, 'isstring', {});
