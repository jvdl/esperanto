/*
	esperanto.js v0.6.18 - 2015-03-26
	http://esperantojs.org

	Released under the MIT License.
*/

'use strict';

var path = require('path');
var sander = require('sander');
var acorn = require('acorn');
var MagicString = require('magic-string');
var estraverse = require('estraverse');

var hasOwnProp = Object.prototype.hasOwnProperty;

function hasNamedImports ( mod ) {
	var i = mod.imports.length;

	while ( i-- ) {
		if ( mod.imports[i].isNamed ) {
			return true;
		}
	}
}

function hasNamedExports ( mod ) {
	var i = mod.exports.length;

	while ( i-- ) {
		if ( !mod.exports[i].isDefault ) {
			return true;
		}
	}
}

/*
	This module traverse a module's AST, attaching scope information
	to nodes as it goes, which is later used to determine which
	identifiers need to be rewritten to avoid collisions
*/

var Scope = function ( options ) {
	options = options || {};

	this.parent = options.parent;
	this.names = options.params || [];
};

Scope.prototype = {
	add: function ( name ) {
		this.names.push( name );
	},

	contains: function ( name, ignoreTopLevel ) {
		if ( ignoreTopLevel && !this.parent ) {
			return false;
		}

		if ( ~this.names.indexOf( name ) ) {
			return true;
		}

		if ( this.parent ) {
			return this.parent.contains( name, ignoreTopLevel );
		}

		return false;
	}
};

function annotateAst ( ast ) {
	var scope = new Scope(), blockScope = new Scope(), declared = {}, topLevelFunctionNames = [], templateLiteralRanges = [];

	var envDepth = 0;

	estraverse.traverse( ast, {
		enter: function ( node ) {
			if ( node.type === 'ImportDeclaration' || node.type === 'ExportSpecifier' ) {
				node._skip = true;
			}

			if ( node._skip ) {
				return this.skip();
			}

			switch ( node.type ) {
				case 'FunctionExpression':
				case 'FunctionDeclaration':

					envDepth++;

					// fallthrough

				case 'ArrowFunctionExpression':
					if ( node.id ) {
						addToScope( node );

						// If this is the root scope, this may need to be
						// exported early, so we make a note of it
						if ( !scope.parent && node.type === 'FunctionDeclaration' ) {
							topLevelFunctionNames.push( node.id.name );
						}
					}

					scope = node._scope = new Scope({
						parent: scope,
						params: node.params.map( function(x ) {return x.name} ) // TODO rest params?
					});

					break;

				case 'BlockStatement':
					blockScope = node._blockScope = new Scope({
						parent: blockScope
					});

					break;

				case 'VariableDeclaration':
					node.declarations.forEach( node.kind === 'let' ? addToBlockScope : addToScope );
					break;

				case 'ClassExpression':
				case 'ClassDeclaration':
					addToScope( node );
					break;

				case 'MemberExpression':
					if ( envDepth === 0 && node.object.type === 'ThisExpression' ) {
						throw new Error('`this` at the top level is undefined');
					}
					!node.computed && ( node.property._skip = true );
					break;

				case 'Property':
					node.key._skip = true;
					break;

				case 'TemplateLiteral':
					templateLiteralRanges.push([ node.start, node.end ]);
					break;

				case 'ThisExpression':
					if (envDepth === 0) {
						node._topLevel = true;
					}
					break;
			}
		},
		leave: function ( node ) {
			switch ( node.type ) {
				case 'FunctionExpression':
				case 'FunctionDeclaration':

					envDepth--;

					// fallthrough

				case 'ArrowFunctionExpression':

					scope = scope.parent;

					break;

				case 'BlockStatement':
					blockScope = blockScope.parent;
					break;
			}
		}
	});

	function addToScope ( declarator ) {
		var name = declarator.id.name;

		scope.add( name );
		declared[ name ] = true;
	}

	function addToBlockScope ( declarator ) {
		var name = declarator.id.name;

		blockScope.add( name );
		declared[ name ] = true;
	}

	ast._scope = scope;
	ast._blockScope = blockScope;
	ast._topLevelNames = ast._scope.names.concat( ast._blockScope.names );
	ast._topLevelFunctionNames = topLevelFunctionNames;
	ast._declared = declared;
	ast._templateLiteralRanges = templateLiteralRanges;
}

/**
 * Inspects a module and discovers/categorises import & export declarations
 * @param {object} mod - the module object
 * @param {string} source - the module's original source code
 * @param {object} ast - the result of parsing `source` with acorn
 * @returns {array} - [ imports, exports ]
 */
function findImportsAndExports ( mod, source, ast ) {
	var imports = [], exports = [], previousDeclaration;

	ast.body.forEach( function(node ) {
		var passthrough, declaration;

		if ( previousDeclaration ) {
			previousDeclaration.next = node.start;

			if ( node.type !== 'EmptyStatement' ) {
				previousDeclaration = null;
			}
		}

		if ( node.type === 'ImportDeclaration' ) {
			declaration = processImport( node );
			imports.push( declaration );
		}

		else if ( node.type === 'ExportDefaultDeclaration' ) {
			declaration = processDefaultExport( node, source );
			exports.push( declaration );

			if ( mod.defaultExport ) {
				throw new Error( 'Duplicate default exports' );
			}
			mod.defaultExport = declaration;
		}

		else if ( node.type === 'ExportNamedDeclaration' ) {
			declaration = processExport( node, source );
			exports.push( declaration );

			if ( node.source ) {
				// it's both an import and an export, e.g.
				// `export { foo } from './bar';
				passthrough = processImport( node, true );
				imports.push( passthrough );

				declaration.passthrough = passthrough;
			}
		}

		if ( declaration ) {
			previousDeclaration = declaration;
		}
	});

	// catch any trailing semicolons
	if ( previousDeclaration ) {
		previousDeclaration.next = source.length;
		previousDeclaration.isFinal = true;
	}

	return [ imports, exports ];
}

/**
 * Generates a representation of an import declaration
 * @param {object} node - the original AST node
 * @param {boolean} passthrough - `true` if this is an `export { foo } from 'bar'`-style declaration
 * @returns {object}
 */
function processImport ( node, passthrough ) {
	var x = {
		id: null, // used by bundler - filled in later
		node: node,
		start: node.start,
		end: node.end,
		passthrough: !!passthrough,

		path: node.source.value,
		specifiers: node.specifiers.map( function(s ) {
			var id;

			if ( s.type === 'ImportNamespaceSpecifier' ) {
				return {
					isBatch: true,
					name: s.local.name, // TODO is this line necessary?
					as: s.local.name
				};
			}

			if ( s.type === 'ImportDefaultSpecifier' ) {
				return {
					isDefault: true,
					name: 'default',
					as: s.local.name
				}
			}

			return {
				name: ( !!passthrough ? s.exported : s.imported ).name,
				as: s.local.name
			};
		})
	};

	// TODO have different types of imports - batch, default, named
	if ( x.specifiers.length === 0 ) {
		x.isEmpty = true;
	} else if ( x.specifiers.length === 1 && x.specifiers[0].isDefault ) {
		x.isDefault = true;
		x.as = x.specifiers[0].as;

	} else if ( x.specifiers.length === 1 && x.specifiers[0].isBatch ) {
		x.isBatch = true;
		x.as = x.specifiers[0].name;
	} else {
		x.isNamed = true;
	}

	return x;
}

function processDefaultExport ( node, source ) {
	var result = {
		isDefault: true,
		node: node,
		start: node.start,
		end: node.end
	};

	var d = node.declaration;

	if ( d.type === 'FunctionExpression' ) {
		// Case 1: `export default function () {...}`
		result.hasDeclaration = true; // TODO remove in favour of result.type
		result.type = 'anonFunction';
	}

	else if ( d.type === 'FunctionDeclaration' ) {
		// Case 2: `export default function foo () {...}`
		result.hasDeclaration = true; // TODO remove in favour of result.type
		result.type = 'namedFunction';
		result.name = d.id.name;
	}

	else if ( d.type === 'ClassExpression' ) {
		// Case 3: `export default class {...}`
		result.hasDeclaration = true; // TODO remove in favour of result.type
		result.type = 'anonClass';
	}

	else if ( d.type === 'ClassDeclaration' ) {
		// Case 4: `export default class Foo {...}`
		result.hasDeclaration = true; // TODO remove in favour of result.type
		result.type = 'namedClass';
		result.name = d.id.name;
	}

	else {
		result.type = 'expression';
		result.name = 'default';
	}

	result.value = source.slice( d.start, d.end );
	result.valueStart = d.start;

	return result;
}

/**
 * Generates a representation of an export declaration
 * @param {object} node - the original AST node
 * @param {string} source - the original source code
 * @returns {object}
 */
function processExport ( node, source ) {
	var result, d;

	result = {
		node: node,
		start: node.start,
		end: node.end
	};

	if ( d = node.declaration ) {
		result.value = source.slice( d.start, d.end );
		result.valueStart = d.start;

		// Case 1: `export var foo = 'bar'`
		if ( d.type === 'VariableDeclaration' ) {
			result.hasDeclaration = true; // TODO remove in favour of result.type
			result.type = 'varDeclaration';
			result.name = d.declarations[0].id.name;
		}

		// Case 2: `export function foo () {...}`
		else if ( d.type === 'FunctionDeclaration' ) {
			result.hasDeclaration = true; // TODO remove in favour of result.type
			result.type = 'namedFunction';
			result.name = d.id.name;
		}

		// Case 3: `export class Foo {...}`
		else if ( d.type === 'ClassDeclaration' ) {
			result.hasDeclaration = true; // TODO remove in favour of result.type
			result.type = 'namedClass';
			result.name = d.id.name;
		}
	}

	// Case 9: `export { foo, bar };`
	else {
		result.type = 'named';
		result.specifiers = node.specifiers.map( function(s ) {
			return { name: s.local.name };
		}); // TODO as?
	}

	return result;
}

function getUnscopedNames ( mod ) {
	var unscoped = [], importedNames, scope;

	function imported ( name ) {
		if ( !importedNames ) {
			importedNames = {};
			mod.imports.forEach( function(i ) {
				!i.passthrough && i.specifiers.forEach( function(s ) {
					importedNames[ s.as ] = true;
				});
			});
		}
		return hasOwnProp.call( importedNames, name );
	}

	estraverse.traverse( mod.ast, {
		enter: function ( node ) {
			// we're only interested in references, not property names etc
			if ( node._skip ) return this.skip();

			if ( node._scope ) {
				scope = node._scope;
			}

			if ( node.type === 'Identifier' &&
					 !scope.contains( node.name ) &&
					 !imported( node.name ) &&
					 !~unscoped.indexOf( node.name ) ) {
				unscoped.push( node.name );
			}
		},

		leave: function ( node ) {
			if ( node.type === 'Program' ) {
				return;
			}

			if ( node._scope ) {
				scope = scope.parent;
			}
		}
	});

	return unscoped;
}

function disallowConflictingImports ( imports ) {
	var usedNames = {};

	imports.forEach( function(x ) {
		if ( x.as ) {
			checkName( x.as );
		}

		else {
			x.specifiers.forEach( checkSpecifier );
		}
	});

	function checkSpecifier ( s ) {
		checkName( s.as );
	}

	function checkName ( name ) {
		if ( hasOwnProp.call( usedNames, name ) ) {
			throw new SyntaxError( (("Duplicated import ('" + name) + "')") );
		}

		usedNames[ name ] = true;
	}
}

var reserved = 'break case class catch const continue debugger default delete do else export extends finally for function if import in instanceof let new return super switch this throw try typeof var void while with yield'.split( ' ' );

/**
 * Generates a sanitized (i.e. valid identifier) name from a module ID
 * @param {string} id - a module ID, or part thereof
 * @returns {string}
 */
function sanitize ( name ) {
	name = name.replace( /[^a-zA-Z0-9_$]/g, '_' );
	if ( /[^a-zA-Z_$]/.test( name[0] ) ) {
		name = '_' + name;
	}

	if ( ~reserved.indexOf( name ) ) {
		name = '_' + name;
	}

	return name;
}

var pathSplitRE = /\/|\\/;
function splitPath ( path ) {
	return path.split( pathSplitRE );
}

var SOURCEMAPPINGURL_REGEX = /^# sourceMappingURL=/;

function getStandaloneModule ( options ) {
	var toRemove = [];

	var mod = {
		body: new MagicString( options.source ),
		ast: acorn.parse( options.source, {
			ecmaVersion: 6,
			sourceType: 'module',
			onComment: function ( block, text, start, end ) {
				// sourceMappingURL comments should be removed
				if ( !block && /^# sourceMappingURL=/.test( text ) ) {
					toRemove.push({ start: start, end: end });
				}
			}
		})
	};

	toRemove.forEach( function(end)  {var start = end.start, end = end.end;return mod.body.remove( start, end )} );

	var imports = (exports = findImportsAndExports( mod, options.source, mod.ast ))[0], exports = exports[1];

	disallowConflictingImports( imports );

	mod.imports = imports;
	mod.exports = exports;

	var conflicts = {};

	if ( options.strict ) {
		annotateAst( mod.ast );

		// TODO there's probably an easier way to get this array
		Object.keys( mod.ast._declared ).concat( getUnscopedNames( mod ) ).forEach( function(n ) {
			conflicts[n] = true;
		});
	}

	determineImportNames( imports, options.getModuleName, conflicts );

	return mod;
}

function determineImportNames ( imports, userFn, usedNames ) {
	var nameById = {}, inferredNames = {};

	usedNames = usedNames || {};

	imports.forEach( function(x ) {
		var moduleId, parts, i, prefix = '', name, candidate;

		moduleId = x.path;

		// use existing value
		if ( hasOwnProp.call( nameById, moduleId ) ) {
			x.name = nameById[ moduleId ];
			return;
		}

		// if user supplied a function, defer to it
		if ( userFn && ( name = userFn( moduleId ) ) ) {
			name = sanitize( name );

			if ( hasOwnProp.call( usedNames, name ) ) {
				// TODO write a test for this
				throw new Error( 'Naming collision: module ' + moduleId + ' cannot be called ' + name );
			}
		}

		else {
			parts = splitPath( moduleId );

			do {
				i = parts.length;
				while ( i-- > 0 ) {
					candidate = prefix + sanitize( parts.slice( i ).join( '__' ) );

					if ( !hasOwnProp.call( usedNames, candidate ) ) {
						name = candidate;
						break;
					}
				}

				prefix += '_';
			} while ( !name );
		}

		usedNames[ name ] = true;
		nameById[ moduleId ] = name;

		x.name = name;
	});

	// use inferred names for default imports, wherever they
	// don't clash with path-based names
	imports.forEach( function(x ) {
		if ( x.as && !hasOwnProp.call( usedNames, x.as ) ) {
			inferredNames[ x.path ] = x.as;
		}
	});

	imports.forEach( function(x ) {
		if ( hasOwnProp.call( inferredNames, x.path ) ) {
			x.name = inferredNames[ x.path ];
		}
	});
}

function resolveId ( importPath, importerPath ) {
	var resolved, importerParts, importParts;

	if ( importPath[0] !== '.' ) {
		resolved = importPath;
	} else {
		importerParts = splitPath( importerPath );
		importParts = splitPath( importPath );

		if ( importParts[0] === '.' ) {
			importParts.shift();
		}

		importerParts.pop(); // get dirname
		while ( importParts[0] === '..' ) {
			importParts.shift();
			importerParts.pop();
		}

		while ( importParts[0] === '.' ) {
			importParts.shift();
		}

		resolved = importerParts.concat( importParts ).join( '/' );
	}

	return resolved.replace( /\.js$/, '' );
}

function resolveAgainst ( importerPath ) {
	return function ( importPath ) {
		return resolveId( importPath, importerPath );
	};
}

function sortModules ( entry, moduleLookup ) {
	var seen = {},
		ordered = [];

	function visit ( mod ) {
		// ignore external modules, and modules we've
		// already included
		if ( !mod || hasOwnProp.call( seen, mod.id ) ) {
			return;
		}

		seen[ mod.id ] = true;

		mod.imports.forEach( function(x ) {
			visit( moduleLookup[ x.id ] );
		});

		ordered.push( mod );
	}

	visit( entry );

	return ordered;
}

function resolveChains ( modules, moduleLookup ) {
	var chains = {};

	// First pass - resolving intra-module chains
	modules.forEach( function(mod ) {
		var origin = {};

		mod.imports.forEach( function(x ) {
			x.specifiers.forEach( function(s ) {
				if ( s.isBatch ) {
					// if this is an internal module, we need to tell that module that
					// it needs to export an object full of getters
					if ( hasOwnProp.call( moduleLookup, x.id ) ) {
						moduleLookup[ x.id ]._exportsNamespace = true;
					}

					return; // TODO can batch imports be chained?
				}

				origin[ s.as ] = x.id + '@' + s.name;
			});
		});

		mod.exports.forEach( function(x ) {
			if ( !x.specifiers ) return;

			x.specifiers.forEach( function(s ) {
				if ( hasOwnProp.call( origin, s.name ) ) {
					chains[ mod.id + '@' + s.name ] = origin[ s.name ];
				}
			});
		});
	});

	return chains;
}

// from https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects
// we add `exports` to this list, to avoid conflicst
var builtins = 'Array ArrayBuffer DataView Date Error EvalError Float32Array Float64Array Function Generator GeneratorFunction Infinity Int16Array Int32Array Int8Array InternalError Intl Iterator JSON Map Math NaN Number Object ParallelArray Promise Proxy RangeError ReferenceError Reflect RegExp Set StopIteration String Symbol SyntaxError TypeError TypedArray URIError Uint16Array Uint32Array Uint8Array Uint8ClampedArray WeakMap WeakSet decodeURI decodeURIComponent encodeURI encodeURIComponent escape eval exports isFinite isNaN null parseFloat parseInt undefined unescape uneval'.split( ' ' );

function getUniqueNames ( modules, externalModules, userNames ) {
	var names = {}, used = {};

	// copy builtins
	builtins.forEach( function(n ) {return used[n] = true} );

	// copy user-specified names
	if ( userNames ) {
		Object.keys( userNames ).forEach( function(n ) {
			names[n] = userNames[n];
			used[ userNames[n] ] = true;
		});
	}

	// infer names from default imports
	modules.forEach( function(mod ) {
		mod.imports.forEach( function(x ) {
			if ( x.isDefault && !hasOwnProp.call( names, x.id ) && !hasOwnProp.call( used, x.as ) ) {
				names[ x.id ] = x.as;
				used[ x.as ] = true;
			}
		});
	});

	// for the rest, make names as compact as possible without
	// introducing conflicts
	modules.concat( externalModules ).forEach( function(mod ) {
		var parts, i, name;

		// is this already named?
		if ( hasOwnProp.call( names, mod.id ) ) {
			return;
		}

		parts = splitPath( mod.id );

		i = parts.length;
		while ( i-- ) {
			name = sanitize( parts.slice( i ).join( '_' ) );

			if ( !hasOwnProp.call( used, name ) ) {
				break;
			}
		}

		while ( hasOwnProp.call( used, name ) ) {
			name = '_' + name;
		}

		used[ name ] = true;
		names[ mod.id ] = name;
	});

	return names;
}

function populateExternalModuleImports ( bundle ) {
	bundle.modules.forEach( function(mod ) {
		mod.imports.forEach( function(x ) {
			var externalModule = bundle.externalModuleLookup[ x.id ];

			if ( !externalModule ) {
				return;
			}

			x.specifiers.forEach( function(s ) {
				if ( s.isDefault ) {
					externalModule.needsDefault = true;
				} else {
					externalModule.needsNamed = true;
				}
			});
		});
	});
}

function getId ( m ) {
	return m.id;
}

function getName ( m ) {
	return m.name;
}

function quote ( str ) {
	return "'" + JSON.stringify(str).slice(1, -1).replace(/'/g, "\\'") + "'";
}

function req ( path ) {
	return 'require(' + quote(path) + ')';
}

function globalify ( name ) {
  	if ( /^__dep\d+__$/.test( name ) ) {
		return 'undefined';
	} else {
		return 'global.' + name;
	}
}

function getRenamedImports ( mod ) {
	var renamed = [];

	mod.imports.forEach( function(x ) {
		if ( x.specifiers ) {
			x.specifiers.forEach( function(s ) {
				if ( s.name !== s.as && !~renamed.indexOf( s.name ) ) {
					renamed.push( s.name );
				}
			});
		}
	});

	return renamed;
}

function topLevelScopeConflicts ( bundle ) {
	var conflicts = {}, inBundle = {};
	var importNames = bundle.externalModules.map( getName );

	bundle.modules.forEach( function(mod ) {
		var names = builtins

			// all top defined identifiers are in top scope
			.concat( mod.ast._topLevelNames )

			// all unattributed identifiers could collide with top scope
			.concat( getUnscopedNames( mod ) )

			.concat( importNames )

			.concat( getRenamedImports( mod ) );

		if ( mod._exportsNamespace ) {
			conflicts[ mod.name ] = true;
		}

		// merge this module's top scope with bundle top scope
		names.forEach( function(name ) {
			if ( hasOwnProp.call( inBundle, name ) ) {
				conflicts[ name ] = true;
			} else {
				inBundle[ name ] = true;
			}
		});
	});

	return conflicts;
}

function populateIdentifierReplacements ( bundle ) {
	// first, discover conflicts
	var conflicts = topLevelScopeConflicts( bundle );

	// then figure out what identifiers need to be created
	// for default exports
	bundle.modules.forEach( function(mod ) {
		var x = mod.defaultExport;

		if ( x ) {
			var result;

			if ( x.hasDeclaration && x.name ) {
				result = hasOwnProp.call( conflicts, x.name ) || otherModulesDeclare( mod, x.name ) ?
					(("" + (mod.name)) + ("__" + (x.name)) + "") :
					x.name;
			} else {
				result = hasOwnProp.call( conflicts, mod.name ) || ( x.value !== mod.name && ~mod.ast._topLevelNames.indexOf( mod.name )) || otherModulesDeclare( mod, mod.name ) ?
					(("" + (mod.name)) + "__default") :
					mod.name;
			}

			mod.identifierReplacements.default = result;
		}
	});

	// then determine which existing identifiers
	// need to be replaced
	bundle.modules.forEach( function(mod ) {
		var moduleIdentifiers;

		moduleIdentifiers = mod.identifierReplacements;

		mod.ast._topLevelNames.forEach( function(n ) {
			moduleIdentifiers[n] = hasOwnProp.call( conflicts, n ) ?
				mod.name + '__' + n :
				n;
		});

		mod.imports.forEach( function(x ) {
			var externalModule;

			if ( x.passthrough ) {
				return;
			}

			externalModule = hasOwnProp.call( bundle.externalModuleLookup, x.id ) && bundle.externalModuleLookup[ x.id ];

			x.specifiers.forEach( function(s ) {
				var moduleId, mod, moduleName, specifierName, replacement, hash, isChained, separatorIndex;

				moduleId = x.id;

				if ( s.isBatch ) {
					replacement = ( bundle.moduleLookup[ moduleId ] || bundle.externalModuleLookup[ moduleId ] ).name;
				}

				else {
					specifierName = s.name;

					// If this is a chained import, get the origin
					hash = moduleId + '@' + specifierName;
					while ( hasOwnProp.call( bundle.chains, hash ) ) {
						hash = bundle.chains[ hash ];
						isChained = true;
					}

					if ( isChained ) {
						separatorIndex = hash.indexOf( '@' );
						moduleId = hash.substr( 0, separatorIndex );
						specifierName = hash.substring( separatorIndex + 1 );
					}

					mod = ( bundle.moduleLookup[ moduleId ] || bundle.externalModuleLookup[ moduleId ] );
					moduleName = mod && mod.name;

					if ( specifierName === 'default' ) {
						// if it's an external module, always use __default if the
						// bundle also uses named imports
						if ( !!externalModule ) {
							replacement = externalModule.needsNamed ? moduleName + '__default' : moduleName;
						}

						// TODO We currently need to check for the existence of `mod`, because modules
						// can be skipped. Would be better to replace skipped modules with dummies
						// - see https://github.com/Rich-Harris/esperanto/issues/32
						else if ( mod ) {
							replacement = mod.identifierReplacements.default;
						}
					} else if ( !externalModule ) {
						replacement = hasOwnProp.call( conflicts, specifierName ) ?
							moduleName + '__' + specifierName :
							specifierName;
					} else {
						replacement = moduleName + '.' + specifierName;
					}
				}

				if ( replacement !== s.as ) {
					moduleIdentifiers[ s.as ] = replacement;
				}
			});
		});
	});

	function otherModulesDeclare ( mod, replacement ) {
		var i, otherMod;

		i = bundle.modules.length;
		while ( i-- ) {
			otherMod = bundle.modules[i];

			if ( mod === otherMod ) {
				continue;
			}

			if ( hasOwnProp.call( otherMod.ast._declared, replacement ) ) {
				return true;
			}
		}
	}
}

function resolveExports ( bundle ) {
	var bundleExports = {};

	bundle.entryModule.exports.forEach( function(x ) {
		var name;

		if ( x.specifiers ) {
			x.specifiers.forEach( function(s ) {
				var hash = bundle.entryModule.id + '@' + s.name,
					split,
					moduleId,
					name;

				while ( bundle.chains[ hash ] ) {
					hash = bundle.chains[ hash ];
				}

				split = hash.split( '@' );
				moduleId = split[0];
				name = split[1];

				addExport( moduleId, name, s.name );

				// if ( !bundleExports[ moduleId ] ) {
				// 	bundleExports[ moduleId ] = {};
				// }

				// bundleExports[ moduleId ][ name ] = s.name;
			});
		}

		else if ( !x.isDefault && ( name = x.name ) ) {
			addExport( bundle.entry, name, name );
		}
	});

	function addExport ( moduleId, name, as ) {
		if ( !bundleExports[ moduleId ] ) {
			bundleExports[ moduleId ] = {};
		}

		bundleExports[ moduleId ][ name ] = as;
	}

	return bundleExports;
}

/**
 * Scans an array of imports, and determines which identifiers
   are readonly, and which cannot be assigned to. For example
   you cannot `import foo from 'foo'` then do `foo = 42`, nor
   can you `import * from 'foo'` then do `foo.answer = 42`
 * @param {array} imports - the array of imports
 * @returns {array} [ importedBindings, importedNamespaces ]
 */
function getReadOnlyIdentifiers ( imports ) {
	var importedBindings = {}, importedNamespaces = {};

	imports.forEach( function(x ) {
		if ( x.passthrough ) return;

		x.specifiers.forEach( function(s ) {
			if ( s.isBatch ) {
				importedNamespaces[ s.as ] = true;
			} else {
				importedBindings[ s.as ] = true;
			}
		});
	});

	return [ importedBindings, importedNamespaces ];
}

var bindingMessage = 'Cannot reassign imported binding ',
	namespaceMessage = 'Cannot reassign imported binding of namespace ';

function disallowIllegalReassignment ( node, importedBindings, importedNamespaces, scope ) {
	var assignee, name, isNamespaceAssignment;

	if ( node.type === 'AssignmentExpression' ) {
		assignee = node.left;
	} else if ( node.type === 'UpdateExpression' ) {
		assignee = node.argument;
	} else {
		return; // not an assignment
	}

	if ( assignee.type === 'MemberExpression' ) {
		assignee = assignee.object;
		isNamespaceAssignment = true;
	}

	if ( assignee.type !== 'Identifier' ) {
		return; // not assigning to a binding
	}

	name = assignee.name;

	if ( hasOwnProp.call( isNamespaceAssignment ? importedNamespaces : importedBindings, name ) && !scope.contains( name ) ) {
		throw new Error( ( isNamespaceAssignment ? namespaceMessage : bindingMessage ) + '`' + name + '`' );
	}
}

function replaceIdentifiers ( body, node, identifierReplacements, scope ) {
	var name = node.name;
	var replacement = hasOwnProp.call( identifierReplacements, name ) && identifierReplacements[ name ];

	// TODO unchanged identifiers shouldn't have got this far -
	// remove the `replacement !== name` safeguard once that's the case
	if ( replacement && replacement !== name && !scope.contains( name, true ) ) {
		// rewrite
		body.replace( node.start, node.end, replacement );
	}
}

function rewriteExportAssignments ( body, node, exports, scope, alreadyExported, isTopLevelNode, capturedUpdates ) {
	var assignee, name, exportAs;

	if ( node.type === 'AssignmentExpression' ) {
		assignee = node.left;
	} else if ( node.type === 'UpdateExpression' ) {
		assignee = node.argument;
	} else {
		return; // not an assignment
	}

	if ( assignee.type !== 'Identifier' ) {
		return;
	}

	name = assignee.name;

	if ( scope.contains( name, true ) ) {
		return; // shadows an export
	}

	if ( exports && hasOwnProp.call( exports, name ) && ( exportAs = exports[ name ] ) ) {
		if ( !!capturedUpdates ) {
			capturedUpdates.push({
				name: name,
				exportAs: exportAs
			});
			return;
		}

		// special case - increment/decrement operators
		if ( node.operator === '++' || node.operator === '--' ) {
			body.replace( node.end, node.end, ((", exports." + exportAs) + (" = " + name) + "") );
		} else {
			body.replace( node.start, node.start, (("exports." + exportAs) + " = ") );
		}

		// keep track of what we've already exported - we don't need to
		// export it again later
		if ( isTopLevelNode ) {
			alreadyExported[ name ] = true;
		}
	}
}

function traverseAst ( ast, body, identifierReplacements, importedBindings, importedNamespaces, exportNames, alreadyExported ) {
	var scope = ast._scope,
		blockScope = ast._blockScope,
		capturedUpdates = null,
		previousCapturedUpdates = null;

	estraverse.traverse( ast, {
		enter: function ( node, parent ) {
			// we're only interested in references, not property names etc
			if ( node._skip ) return this.skip();

			if ( node._scope ) {
				scope = node._scope;
			} else if ( node._blockScope ) {
				blockScope = node._blockScope;
			}

			// Special case: if you have a variable declaration that updates existing
			// bindings as a side-effect, e.g. `var a = b++`, where `b` is an exported
			// value, we can't simply append `exports.b = b` to the update (as we
			// normally would) because that would be syntactically invalid. Instead,
			// we capture the change and update the export (and any others) after the
			// variable declaration
			if ( node.type === 'VariableDeclaration' ) {
				previousCapturedUpdates = capturedUpdates;
				capturedUpdates = [];
				return;
			}

			// Catch illegal reassignments
			disallowIllegalReassignment( node, importedBindings, importedNamespaces, scope );

			// Rewrite assignments to exports. This call may mutate `alreadyExported`
			// and `capturedUpdates`, which are used elsewhere
			rewriteExportAssignments( body, node, exportNames, scope, alreadyExported, scope === ast._scope, capturedUpdates );

			if ( node.type === 'Identifier' && parent.type !== 'FunctionExpression' ) {
				replaceIdentifiers( body, node, identifierReplacements, scope );
			}

			// Replace top-level this with undefined ES6 8.1.1.5.4
			if ( node.type === 'ThisExpression' && node._topLevel ) {
				body.replace( node.start, node.end, 'undefined' );
			}
		},

		leave: function ( node ) {
			// Special case - see above
			if ( node.type === 'VariableDeclaration' ) {
				if ( capturedUpdates.length ) {
					body.insert( node.end, capturedUpdates.map( exportCapturedUpdate ).join( '' ) );
				}

				capturedUpdates = previousCapturedUpdates;
			}

			if ( node._scope ) {
				scope = scope.parent;
			} else if ( node._blockScope ) {
				blockScope = blockScope.parent;
			}
		}
	});
}

function exportCapturedUpdate ( c ) {
	return ((" exports." + (c.name)) + (" = " + (c.exportAs)) + ";");
}

function transformBody__transformBody ( bundle, mod, body ) {var $D$0;
	var identifierReplacements,
		importedBindings,
		importedNamespaces,
		exportNames,
		alreadyExported = {},
		shouldExportEarly = {},
		exportBlock;

	identifierReplacements = mod.identifierReplacements;
	importedBindings = ($D$0 = getReadOnlyIdentifiers( mod.imports ))[0], importedNamespaces = $D$0[1], $D$0;

	exportNames = hasOwnProp.call( bundle.exports, mod.id ) && bundle.exports[ mod.id ];

	traverseAst( mod.ast, body, identifierReplacements, importedBindings, importedNamespaces, exportNames, alreadyExported );

	// Remove import statements
	mod.imports.forEach( function(x ) {
		if ( !x.passthrough ) {
			body.remove( x.start, x.next );
		}
	});

	// Remove export statements
	mod.exports.forEach( function(x ) {
		var name;

		if ( x.isDefault ) {
			if ( x.type === 'namedFunction' || x.type === 'namedClass' ) {
				// if you have a default export like
				//
				//     export default function foo () {...}
				//
				// you need to rewrite it as
				//
				//     function foo () {...}
				//     exports.default = foo;
				//
				// as the `foo` reference may be used elsewhere

				// remove the `export default `, keep the rest
				body.remove( x.start, x.valueStart );
			}

			else if ( x.node.declaration && ( name = x.node.declaration.name ) ) {
				if ( name === identifierReplacements.default ) {
					body.remove( x.start, x.end );
				} else {
					var original = hasOwnProp.call( identifierReplacements, name ) ? identifierReplacements[ name ] : name;
					body.replace( x.start, x.end, (("var " + (identifierReplacements.default)) + (" = " + original) + ";") );
				}
			}

			else {
				body.replace( x.start, x.valueStart, (("var " + (identifierReplacements.default)) + " = ") );
			}

			return;
		}

		if ( x.hasDeclaration ) {
			if ( x.type === 'namedFunction' ) {
				shouldExportEarly[ x.name ] = true; // TODO what about `function foo () {}; export { foo }`?
			}

			body.remove( x.start, x.valueStart );
		} else {
			body.remove( x.start, x.next );
		}
	});

	// If this module exports a namespace - i.e. another module does
	// `import * from 'foo'` - then we need to make all this module's
	// exports available, using Object.defineProperty
	var indentStr = body.getIndentString();
	if ( mod._exportsNamespace ) {
		var namespaceExportBlock = (("var " + (mod.name)) + " = {\n"),
			namespaceExports = [];

		mod.exports.forEach( function(x ) {
			if ( x.hasDeclaration ) {
				namespaceExports.push( indentStr + (("get " + (x.name)) + (" () { return " + (identifierReplacements[x.name])) + "; }") );
			}

			else if ( x.isDefault ) {
				namespaceExports.push( indentStr + (("get default () { return " + (identifierReplacements.default)) + "; }") );
			}

			else {
				x.specifiers.forEach( function(s ) {
					namespaceExports.push( indentStr + (("get " + (s.name)) + (" () { return " + (s.name)) + "; }") );
				});
			}
		});

		namespaceExportBlock += namespaceExports.join( ',\n' ) + '\n};\n\n';

		body.prepend( namespaceExportBlock );
	}

	// If this module is responsible for one of the bundle's exports
	// (it doesn't have to be the entry module, which could re-export
	// a binding from another module), we write exports here
	if ( exportNames ) {
		exportBlock = [];

		Object.keys( exportNames ).forEach( function(name ) {
			var exportAs;

			if ( !alreadyExported[ name ] ) {
				exportAs = exportNames[ name ];
				exportBlock.push( (("exports." + exportAs) + (" = " + (identifierReplacements[name])) + ";") );
			}
		});

		if ( exportBlock.length ) {
			body.trim().append( '\n\n' + exportBlock.join( '\n' ) );
		}
	}

	return body.trim();
;$D$0 = void 0}

function combine ( bundle ) {
	var body;

	body = new MagicString.Bundle({
		separator: '\n\n'
	});

	// populate names
	var uniqueNames = getUniqueNames( bundle.modules, bundle.externalModules, bundle.names );
	var setName = function(mod ) {return mod.name = uniqueNames[ mod.id ]};
	bundle.modules.forEach( setName );
	bundle.externalModules.forEach( setName );

	// determine which specifiers are imported from
	// external modules
	populateExternalModuleImports( bundle );

	// determine which identifiers need to be replaced
	// inside this bundle
	populateIdentifierReplacements( bundle );

	bundle.exports = resolveExports( bundle );

	bundle.modules.forEach( function(mod ) {
		// verify that this module doesn't import non-exported identifiers
		mod.imports.forEach( function(x ) {
			var importedModule = bundle.moduleLookup[ x.id ];

			if ( !importedModule || x.isBatch ) {
				return;
			}

			x.specifiers.forEach( function(s ) {
				if ( !importedModule.doesExport[ s.name ] ) {
					throw new Error( 'Module ' + importedModule.id + ' does not export ' + s.name + ' (imported by ' + mod.id + ')' );
				}
			});
		});

		body.addSource({
			filename: path.resolve( bundle.base, mod.relativePath ),
			content: transformBody__transformBody( bundle, mod, mod.body ),
			indentExclusionRanges: mod.ast._templateLiteralRanges
		});
	});

	bundle.body = body;
}

function getModule ( mod ) {var $D$1;
	var imports, exports;

	mod.body = new MagicString( mod.source );

	try {
		mod.ast = acorn.parse( mod.source, {
			ecmaVersion: 6,
			sourceType: 'module'
		});

		annotateAst( mod.ast );
	} catch ( err ) {
		// If there's a parse error, attach file info
		// before throwing the error
		if ( err.loc ) {
			err.file = mod.path;
		}

		throw err;
	}

	imports = ($D$1 = findImportsAndExports( mod, mod.source, mod.ast ))[0], exports = $D$1[1], $D$1;

	disallowConflictingImports( imports );

	mod.imports = imports;
	mod.exports = exports;

	// identifiers to replace within this module
	// (gets filled in later, once bundle is combined)
	mod.identifierReplacements = {};

	// collect exports by name, for quick lookup when verifying
	// that this module exports a given identifier
	mod.doesExport = {};

	exports.forEach( function(x ) {
		if ( x.isDefault ) {
			mod.doesExport.default = true;
		}

		else if ( x.name ) {
			mod.doesExport[ x.name ] = true;
		}

		else if ( x.specifiers ) {
			x.specifiers.forEach( function(s ) {
				mod.doesExport[ s.name ] = true;
			});
		}

		else {
			throw new Error( 'Unexpected export type' );
		}
	});

	return mod;
;$D$1 = void 0}

var getBundle__Promise = sander.Promise;

function getBundle ( options ) {
	var entry = options.entry.replace( /\.js$/, '' ),
		modules = [],
		moduleLookup = {},
		promiseByPath = {},
		skip = options.skip,
		names = options.names,
		base = ( options.base ? path.resolve( options.base ) : process.cwd() ) + '/',
		externalModules = [],
		externalModuleLookup = {};

	if ( !entry.indexOf( base ) ) {
		entry = entry.substring( base.length );
	}

	return resolvePath( base, entry, null ).then( function(entryPath ) {
		return fetchModule( entry, entryPath ).then( function()  {
			var entryModule, bundle;

			entryModule = moduleLookup[ entry ];
			modules = sortModules( entryModule, moduleLookup ); // TODO is this necessary? surely it's already sorted because of the fetch order? or do we need to prevent parallel reads?

			bundle = {
				entry: entry,
				entryModule: entryModule,
				base: base,
				modules: modules,
				moduleLookup: moduleLookup,
				externalModules: externalModules,
				externalModuleLookup: externalModuleLookup,
				skip: skip,
				names: names,
				chains: resolveChains( modules, moduleLookup )
			};

			combine( bundle );

			return bundle;
		});
	}, function ( err ) {
		if ( err.code === 'ENOENT' ) {
			throw new Error( 'Could not find entry module (' + entry + ')' );
		}

		throw err;
	});

	function fetchModule ( moduleId, modulePath ) {
		if ( !hasOwnProp.call( promiseByPath, modulePath ) ) {
			promiseByPath[ modulePath ] = sander.readFile( modulePath ).then( String ).then( function ( source ) {
				var module, promises;

				if ( options.transform ) {
					source = options.transform( source, modulePath );

					if ( typeof source !== 'string' && !isThenable( source ) ) {
						throw new Error( 'transform should return String or Promise' );
					}
				}

				module = getModule({
					source: source,
					id: moduleId,
					relativePath: path.relative( base, modulePath ),
					path: modulePath
				});

				modules.push( module );
				moduleLookup[ moduleId ] = module;

				promises = module.imports.map( function(x ) {
					x.id = resolveId( x.path, module.relativePath );

					if ( x.id === moduleId ) {
						throw new Error( 'A module (' + moduleId + ') cannot import itself' );
					}

					// Some modules can be skipped
					if ( skip && ~skip.indexOf( x.id ) ) {
						return;
					}

					return resolvePath( base, x.id, modulePath, options.resolvePath ).then( function(modulePath ) {
						// short-circuit cycles
						if ( hasOwnProp.call( promiseByPath, modulePath ) ) {
							return;
						}

						return fetchModule( x.id, modulePath );
					}, function handleError ( err ) {
						if ( err.code === 'ENOENT' ) {
							// Most likely an external module
							if ( !hasOwnProp.call( externalModuleLookup, x.id ) ) {
								var externalModule = {
									id: x.id
								};

								externalModules.push( externalModule );
								externalModuleLookup[ x.id ] = externalModule;
							}
						} else {
							throw err;
						}
					} );
				});

				return getBundle__Promise.all( promises );
			});
		}

		return promiseByPath[ modulePath ];
	}
}

function resolvePath ( base, moduleId, importerPath, resolver ) {
	return tryPath( path.resolve( base, moduleId + '.js' ) )
		.catch( function () {
			return tryPath( path.resolve( base, moduleId, 'index.js' ) );
		})
		.catch( function ( err ) {
			if ( resolver ) {
				return resolver( moduleId, importerPath );
			} else {
				throw err;
			}
		});
}

function tryPath ( path ) {
	return sander.stat( path ).then( function () {
		return path;
	});
}

function isThenable ( obj ) {
	return obj && typeof obj.then === 'function';
}

function transformExportDeclaration ( declaration, body ) {
	if ( !declaration ) {
		return;
	}

	var exportedValue;

	switch ( declaration.type ) {
		case 'namedFunction':
		case 'namedClass':
			body.remove( declaration.start, declaration.valueStart );
			exportedValue = declaration.name;
			break;

		case 'anonFunction':
		case 'anonClass':
			if ( declaration.isFinal ) {
				body.replace( declaration.start, declaration.valueStart, 'return ' );
			} else {
				body.replace( declaration.start, declaration.valueStart, 'var __export = ' );
				exportedValue = '__export';
			}

			// add semi-colon, if necessary
			// TODO body.original is an implementation detail of magic-string - there
			// should probably be an API for this sort of thing
			if ( body.original[ declaration.end - 1 ] !== ';' ) {
				body.insert( declaration.end, ';' );
			}

			break;

		case 'expression':
			body.remove( declaration.start, declaration.next );
			exportedValue = declaration.value;
			break;

		default:
			throw new Error( (("Unexpected export type '" + (declaration.type)) + "'") );
	}

	if ( exportedValue ) {
		body.append( '\nreturn ' + exportedValue + ';' );
	}
}

var warned = {};

function packageResult ( bundleOrModule, body, options, methodName, isBundle ) {
	var code, map;

	// wrap output
	if ( options.banner ) body.prepend( options.banner );
	if ( options.footer ) body.append( options.footer );

	code = body.toString();

	if ( !!options.sourceMap ) {
		if ( options.sourceMap !== 'inline' && !options.sourceMapFile) {
			throw new Error( 'You must provide `sourceMapFile` option' );
		}

		if ( !isBundle && !options.sourceMapSource ) {
			throw new Error( 'You must provide `sourceMapSource` option' );
		}

		var sourceMapFile;
		if (options.sourceMap === 'inline') {
			sourceMapFile = null;
		} else {
			sourceMapFile = isAbsolutePath( options.sourceMapFile ) ? options.sourceMapFile : './' + splitPath( options.sourceMapFile ).pop();
		}

		if ( isBundle ) {
			markBundleSourcemapLocations( bundleOrModule );
		} else {
			markModuleSourcemapLocations( bundleOrModule );
		}

		map = body.generateMap({
			includeContent: true,
			file: sourceMapFile,
			source: (sourceMapFile && !isBundle) ? getRelativePath( sourceMapFile, options.sourceMapSource ) : null
		});

		if ( options.sourceMap === 'inline' ) {
			code += '\n//# sourceMa' + 'ppingURL=' + map.toUrl();
			map = null;
		} else {
			code += '\n//# sourceMa' + 'ppingURL=' + sourceMapFile + '.map';
		}
	} else {
		map = null;
	}

	return {
		code: code,
		map: map,
		toString: function () {
			if ( !warned[ methodName ] ) {
				console.log( 'Warning: esperanto.' + methodName + '() returns an object with a \'code\' property. You should use this instead of using the returned value directly' );
				warned[ methodName ] = true;
			}

			return code;
		}
	};
}

function isAbsolutePath ( path ) {
	return /^(?:[A-Z]:)?[\/\\]/i.test( path );
}

function getRelativePath ( from, to ) {
	var fromParts, toParts, i;

	fromParts = splitPath( from );
	toParts = splitPath( to );

	fromParts.pop(); // get dirname

	while ( fromParts[0] === toParts[0] ) {
		fromParts.shift();
		toParts.shift();
	}

	if ( fromParts.length ) {
		i = fromParts.length;
		while ( i-- ) fromParts[i] = '..';

		return fromParts.concat( toParts ).join( '/' );
	} else {
		toParts.unshift( '.' );
		return toParts.join( '/' );
	}
}

function markBundleSourcemapLocations ( bundle ) {
	bundle.modules.forEach( function(mod ) {
		estraverse.traverse( mod.ast, {
			enter: function(node ) {
				mod.body.addSourcemapLocation( node.start );
			}
		});
	})
}

function markModuleSourcemapLocations ( mod ) {
	estraverse.traverse( mod.ast, {
		enter: function(node ) {
			mod.body.addSourcemapLocation( node.start );
		}
	});
}

/**
 * Creates a template function from a template string. The template
   may have `<%= someVar %>` interpolators, and the returned function
   should be called with a data object e.g. `{ someVar: 'someData' }`
 * @param {string} str - the template string
 * @returns {function}
 */
function template ( str ) {
	return function ( data ) {
		return str.replace( /<%=\s*([^\s]+)\s*%>/g, function ( match, $1 ) {
			return $1 in data ? data[ $1 ] : match;
		});
	};
}

var amd__introTemplate = template( 'define(<%= amdName %><%= paths %>function (<%= names %>) {\n\n' );

function amd__amd ( mod, options ) {
	var seen = {},
		importNames = [],
		importPaths = [],
		intro,
		placeholders = 0;

	// gather imports, and remove import declarations
	mod.imports.forEach( function(x ) {
		var path = options.absolutePaths ? resolveId( x.path, options.amdName ) : x.path;

		if ( !hasOwnProp.call( seen, path ) ) {
			importPaths.push( path );

			if ( x.as ) {
				while ( placeholders ) {
					importNames.push( '__dep' + importNames.length + '__' );
					placeholders--;
				}
				importNames.push( x.as );
			} else {
				placeholders++;
			}

			seen[ path ] = true;
		}

		mod.body.remove( x.start, x.next );
	});

	transformExportDeclaration( mod.exports[0], mod.body );

	intro = amd__introTemplate({
		amdName: options.amdName ? (("'" + (options.amdName)) + "', ") : '',
		paths: importPaths.length ? '[' + importPaths.map( quote ).join( ', ' ) + '], ' : '',
		names: importNames.join( ', ' )
	});

	mod.body.trim()
		.prepend( "'use strict';\n\n" )
		.trim()
		.indent()
		.prepend( intro )
		.append( '\n\n});' );

	return packageResult( mod, mod.body, options, 'toAmd' );
}

function cjs__cjs ( mod, options ) {
	var seen = {}, exportDeclaration;

	mod.imports.forEach( function(x ) {
		if ( !hasOwnProp.call( seen, x.path ) ) {
			var replacement = x.isEmpty ? (("" + (req(x.path))) + ";") : (("var " + (x.as)) + (" = " + (req(x.path))) + ";");
			mod.body.replace( x.start, x.end, replacement );

			seen[ x.path ] = true;
		} else {
			mod.body.remove( x.start, x.next );
		}
	});

	exportDeclaration = mod.exports[0];

	if ( exportDeclaration ) {
		switch ( exportDeclaration.type ) {
			case 'namedFunction':
			case 'namedClass':
				mod.body.remove( exportDeclaration.start, exportDeclaration.node.declaration.start );
				mod.body.replace( exportDeclaration.end, exportDeclaration.end, (("\nmodule.exports = " + (exportDeclaration.node.declaration.id.name)) + ";") );
				break;

			default:
				mod.body.replace( exportDeclaration.start, exportDeclaration.node.declaration.start, 'module.exports = ' );
				break;
		}
	}

	mod.body.prepend( "'use strict';\n\n" ).trimLines();

	return packageResult( mod, mod.body, options, 'toCjs' );
}

function standaloneUmdIntro ( options, indentStr ) {
	var amdName = options.amdName ?
		quote(options.amdName) + ", " :
		'';

	var intro =
(("(function (factory) {\
\n	!(typeof exports === 'object' && typeof module !== 'undefined') &&\
\n	typeof define === 'function' && define.amd ? define(" + amdName) + "factory) :\
\n	factory()\
\n}(function () { 'use strict';\
\n\
\n");

	return intro.replace( /\t/g, indentStr );
}

function defaultUmdIntro ( options, indentStr ) {
	var hasExports = options.hasExports;

	var amdName = options.amdName ?
		quote(options.amdName) + ", " :
		'';
	var amdDeps = options.importPaths.length > 0 ?
		'[' + ( options.absolutePaths ? options.importPaths.map( resolveAgainst( options.amdName ) ) : options.importPaths ).map( quote ).join( ', ' ) + '], ' :
		'';
	var cjsDeps = options.importPaths.map( req ).join( ', ' );
	var globalDeps = options.importNames.map( globalify ).join( ', ' );
	var args = options.importNames.join( ', ' );

	var cjsExport =
		(hasExports ? 'module.exports = ' : '') + (("factory(" + cjsDeps) + ")");

	var globalExport =
		(hasExports ? (("global." + (options.name)) + " = ") : '') + (("factory(" + globalDeps) + ")");


	var intro =
(("(function (global, factory) {\
\n	typeof exports === 'object' && typeof module !== 'undefined' ? " + cjsExport) + (" :\
\n	typeof define === 'function' && define.amd ? define(" + amdName) + ("" + amdDeps) + ("factory) :\
\n	" + globalExport) + ("\
\n}(this, function (" + args) + ") { 'use strict';\
\n\
\n");

	return intro.replace( /\t/g, indentStr );
}

var EsperantoError = function ( message, data ) {
	var prop;

	this.message = message;
	this.stack = (new Error()).stack;

	for ( prop in data ) {
		if ( data.hasOwnProperty( prop ) ) {
			this[ prop ] = data[ prop ];
		}
	}
};

EsperantoError.prototype = new Error();
EsperantoError.prototype.constructor = EsperantoError;
EsperantoError.prototype.name = 'EsperantoError';

function requireName ( options ) {
	if ( !options.name ) {
		throw new EsperantoError( 'You must supply a `name` option for UMD modules', {
			code: 'MISSING_NAME'
		});
	}
}

function umd__umd ( mod, options ) {
	var importNames = [];
	var importPaths = [];
	var seen = {};
	var placeholders = 0;

	requireName( options );

	var hasImports = mod.imports.length > 0;
	var hasExports = mod.exports.length > 0;

	var intro;
	if (!hasImports && !hasExports) {
		intro = standaloneUmdIntro({
			amdName: options.amdName,
		}, mod.body.getIndentString() );
	} else {
		// gather imports, and remove import declarations
		mod.imports.forEach( function(x ) {
			if ( !hasOwnProp.call( seen, x.path ) ) {
				importPaths.push( x.path );

				if ( x.as ) {
					while ( placeholders ) {
						importNames.push( '__dep' + importNames.length + '__' );
						placeholders--;
					}
					importNames.push( x.as );
				} else {
					placeholders++;
				}

				seen[ x.path ] = true;
			}

			mod.body.remove( x.start, x.next );
		});

		transformExportDeclaration( mod.exports[0], mod.body );

		intro = defaultUmdIntro({
			hasExports: hasExports,
			importPaths: importPaths,
			importNames: importNames,
			amdName: options.amdName,
			absolutePaths: options.absolutePaths,
			name: options.name
		}, mod.body.getIndentString() );
	}

	mod.body.indent().prepend( intro ).trimLines().append( '\n\n}));' );

	return packageResult( mod, mod.body, options, 'toUmd' );
}

var defaultsMode = {
	amd: amd__amd,
	cjs: cjs__cjs,
	umd: umd__umd
};

function gatherImports ( imports ) {
	var chains = {}, identifierReplacements = {};

	imports.forEach( function(x ) {
		x.specifiers.forEach( function(s ) {
			var name, replacement;

			if ( s.isBatch ) {
				return;
			}

			name = s.as;
			replacement = x.name + ( s.isDefault ? ("['default']") : ("." + (s.name)) );

			if ( !x.passthrough ) {
				identifierReplacements[ name ] = replacement;
			}

			chains[ name ] = replacement;
		});
	});

	return [ chains, identifierReplacements ];
}

function getExportNames ( exports ) {
	var result = {};

	exports.forEach( function(x ) {
		if ( x.isDefault ) return;

		if ( x.hasDeclaration ) {
			result[ x.name ] = x.name;
			return;
		}

		x.specifiers.forEach( function(s ) {
			result[ s.name ] = s.name;
		});
	});

	return result;
}

function utils_transformBody__transformBody ( mod, body, options ) {var $D$2;
	var chains,
		identifierReplacements,
		importedBindings = {},
		importedNamespaces = {},
		exportNames,
		alreadyExported = {},
		earlyExports,
		lateExports;

	chains = ($D$2 = gatherImports( mod.imports ))[0], identifierReplacements = $D$2[1], $D$2;
	exportNames = getExportNames( mod.exports );

	importedBindings = ($D$2 = getReadOnlyIdentifiers( mod.imports ))[0], importedNamespaces = $D$2[1], $D$2;

	// ensure no conflict with `exports`
	identifierReplacements.exports = deconflict( 'exports', mod.ast._declared );

	traverseAst( mod.ast, body, identifierReplacements, importedBindings, importedNamespaces, exportNames, alreadyExported );

	// Remove import statements from the body of the module
	mod.imports.forEach( function(x ) {
		if ( x.passthrough ) {
			// this is an `export { foo } from './bar'` statement -
			// it will be dealt with in the next section
			return;
		}

		body.remove( x.start, x.next );
	});

	// Prepend require() statements (CommonJS output only)
	if ( options.header ) {
		body.prepend( options.header + '\n\n' );
	}

	// Remove export statements (but keep declarations)
	mod.exports.forEach( function(x ) {
		if ( x.isDefault ) {
			if ( /^named/.test( x.type ) ) {
				// export default function answer () { return 42; }
				body.remove( x.start, x.valueStart );
				body.insert( x.end, (("\nexports['default'] = " + (x.name)) + ";") );
			} else {
				// everything else
				body.replace( x.start, x.valueStart, 'exports[\'default\'] = ' );
			}
		}

		else {
			switch ( x.type ) {
				case 'varDeclaration': // export var answer = 42; (or let)
				case 'namedFunction':  // export function answer () {...}
				case 'namedClass':     // export class answer {...}
					body.remove( x.start, x.valueStart );
					break;

				case 'named':          // export { foo, bar };
					body.remove( x.start, x.next );
					break;

				default:
					body.replace( x.start, x.valueStart, 'exports[\'default\'] = ' );
			}
		}
	});

	// Append export block (this is the same for all module types, unlike imports)
	earlyExports = [];
	lateExports = [];

	Object.keys( exportNames ).forEach( function(name ) {
		var exportAs = exportNames[ name ];

		if ( chains.hasOwnProperty( name ) ) {
			// special case - a binding from another module
			if ( !options._evilES3SafeReExports ) {
				earlyExports.push( (("Object.defineProperty(exports, '" + exportAs) + ("', { enumerable: true, get: function () { return " + (chains[name])) + "; }});") );
			} else {
				lateExports.push( (("exports." + exportAs) + (" = " + (chains[name])) + ";") );
			}
		} else if ( ~mod.ast._topLevelFunctionNames.indexOf( name ) ) {
			// functions should be exported early, in
			// case of cyclic dependencies
			earlyExports.push( (("exports." + exportAs) + (" = " + name) + ";") );
		} else if ( !alreadyExported.hasOwnProperty( name ) ) {
			lateExports.push( (("exports." + exportAs) + (" = " + name) + ";") );
		}
	});

	// Function exports should be exported immediately after 'use strict'
	if ( earlyExports.length ) {
		body.trim().prepend( earlyExports.join( '\n' ) + '\n\n' );
	}

	// Everything else should be exported at the end
	if ( lateExports.length ) {
		body.trim().append( '\n\n' + lateExports.join( '\n' ) );
	}

	if ( options.intro && options.outro ) {
		body.indent().prepend( options.intro ).trimLines().append( options.outro );
	}
;$D$2 = void 0}

function deconflict ( name, declared ) {
	while ( hasOwnProp.call( declared, name ) ) {
		name = '_' + name;
	}

	return name;
}

function getImportSummary ( mod ) {
	var importPaths = [], importNames = [], seen = {}, placeholders = 0;

	mod.imports.forEach( function(x ) {
		if ( !hasOwnProp.call( seen, x.path ) ) {
			importPaths.push( x.path );

			if ( x.specifiers.length ) {
				while ( placeholders ) {
					importNames.push( '__dep' + importNames.length + '__' );
					placeholders--;
				}
				importNames.push( x.name );
			} else {
				placeholders++;
			}

			seen[ x.path ] = true;
		}
	});

	return [ importPaths, importNames ];
}

var strictMode_amd__introTemplate;

strictMode_amd__introTemplate = template( 'define(<%= amdName %><%= paths %>function (<%= names %>) {\n\n\t\'use strict\';\n\n' );

function strictMode_amd__amd ( mod, options ) {var $D$3;
	var importPaths,
		importNames,
		intro;

	importPaths = ($D$3 = getImportSummary( mod ))[0], importNames = $D$3[1], $D$3;

	if ( mod.exports.length ) {
		importPaths.unshift( 'exports' );
		importNames.unshift( 'exports' );
	}

	intro = strictMode_amd__introTemplate({
		amdName: options.amdName ? (("'" + (options.amdName)) + "', ") : '',
		paths: importPaths.length ? '[' + ( options.absolutePaths ? importPaths.map( resolveAgainst( options.amdName ) ) : importPaths ).map( quote ).join( ', ' ) + '], ' : '',
		names: importNames.join( ', ' )
	}).replace( /\t/g, mod.body.getIndentString() );

	utils_transformBody__transformBody( mod, mod.body, {
		intro: intro,
		outro: '\n\n});',
		_evilES3SafeReExports: options._evilES3SafeReExports
	});

	return packageResult( mod, mod.body, options, 'toAmd' );
;$D$3 = void 0}

function strictMode_cjs__cjs ( mod, options ) {
	var importBlock, seen = {};

	// Create block of require statements
	importBlock = mod.imports.map( function(x ) {
		var name, replacement;

		if ( !hasOwnProp.call( seen, x.path ) ) {
			if ( x.isEmpty ) {
				replacement = (("" + (req(x.path))) + ";");
			} else {
				replacement = (("var " + (x.name)) + (" = " + (req(x.path))) + ";");
			}

			seen[ x.path ] = true;
		}

		return replacement;
	}).filter( Boolean ).join( '\n' );

	utils_transformBody__transformBody( mod, mod.body, {
		header: importBlock,
		_evilES3SafeReExports: options._evilES3SafeReExports
	});

	mod.body.prepend( "'use strict';\n\n" ).trimLines();

	return packageResult( mod, mod.body, options, 'toCjs' );
}

function strictUmdIntro ( options, indentStr ) {
	var hasExports = options.hasExports;

	var amdName = options.amdName ?
		"'" + options.amdName + "', " :
		'';
	var amdDeps = hasExports || options.importPaths.length > 0 ?
		'[' +
			( hasExports ? [ 'exports' ] : [] ).concat( options.absolutePaths ? options.importPaths.map( resolveAgainst( options.amdName ) ) : options.importPaths ).map( quote ).join( ', ' ) +
		'], ' :
		'';
	var cjsDeps = ( hasExports ? [ 'exports' ] : [] ).concat( options.importPaths.map( req ) ).join( ', ' );
	var globalDeps = ( hasExports ? [ (("(global." + (options.name)) + " = {})") ] : [] )
		.concat( options.importNames.map( globalify ) ).join( ', ' );
	var args = ( hasExports ? [ 'exports' ] : [] ).concat( options.importNames ).join( ', ' );

	var defaultsBlock = '';
	if ( options.externalDefaults && options.externalDefaults.length > 0 ) {
		defaultsBlock = options.externalDefaults.map( function(x )
			{return '\t' + ( x.needsNamed ? (("var " + (x.name)) + "__default") : x.name ) +
				((" = ('default' in " + (x.name)) + (" ? " + (x.name)) + ("['default'] : " + (x.name)) + ");")}
		).join('\n') + '\n\n';
	}

	var intro =
(("(function (global, factory) {\
\n	typeof exports === 'object' && typeof module !== 'undefined' ? factory(" + cjsDeps) + (") :\
\n	typeof define === 'function' && define.amd ? define(" + amdName) + ("" + amdDeps) + ("factory) :\
\n	factory(" + globalDeps) + (")\
\n}(this, function (" + args) + (") { 'use strict';\
\n\
\n" + defaultsBlock) + "");

	return intro.replace( /\t/g, indentStr );
}

function strictMode_umd__umd ( mod, options ) {
	requireName( options );

	var importPaths = (importNames = getImportSummary( mod ))[0], importNames = importNames[1];

	var hasImports = mod.imports.length > 0;
	var hasExports = mod.exports.length > 0;

	var intro;
	if (!hasImports && !hasExports) {
		intro = standaloneUmdIntro({
			amdName: options.amdName,
		}, mod.body.getIndentString() );
	} else {
		intro = strictUmdIntro({
			hasExports: hasExports,
			importPaths: importPaths,
			importNames: importNames,
			amdName: options.amdName,
			absolutePaths: options.absolutePaths,
			name: options.name
		}, mod.body.getIndentString() );
	}

	utils_transformBody__transformBody( mod, mod.body, {
		intro: intro,
		outro: '\n\n}));',
		_evilES3SafeReExports: options._evilES3SafeReExports
	});

	return packageResult( mod, mod.body, options, 'toUmd' );
}

var strictMode = {
	amd: strictMode_amd__amd,
	cjs: strictMode_cjs__cjs,
	umd: strictMode_umd__umd
};

// TODO rewrite with named imports/exports
var moduleBuilders = {
	defaultsMode: defaultsMode,
	strictMode: strictMode
};

var defaultsMode_amd__introTemplate = template( 'define(<%= amdName %><%= amdDeps %>function (<%= names %>) {\n\n\t\'use strict\';\n\n' );

function defaultsMode_amd__amd ( bundle, options ) {
	var defaultName = bundle.entryModule.identifierReplacements.default;
	if ( defaultName ) {
		bundle.body.append( (("\n\nreturn " + defaultName) + ";") );
	}

	var intro = defaultsMode_amd__introTemplate({
		amdName: options.amdName ? (("" + (quote(options.amdName))) + ", ") : '',
		amdDeps: bundle.externalModules.length ? '[' + bundle.externalModules.map( quoteId ).join( ', ' ) + '], ' : '',
		names: bundle.externalModules.map( getName ).join( ', ' )
	}).replace( /\t/g, bundle.body.getIndentString() );

	bundle.body.indent().prepend( intro ).trimLines().append( '\n\n});' );
	return packageResult( bundle, bundle.body, options, 'toAmd', true );
}

function quoteId ( m ) {
	return "'" + m.id + "'";
}

function defaultsMode_cjs__cjs ( bundle, options ) {
	var importBlock = bundle.externalModules.map( function(x ) {
		return (("var " + (x.name)) + (" = " + (req(x.id))) + ";");
	}).join( '\n' );

	if ( importBlock ) {
		bundle.body.prepend( importBlock + '\n\n' );
	}

	var defaultName = bundle.entryModule.identifierReplacements.default;
	if ( defaultName ) {
		bundle.body.append( (("\n\nmodule.exports = " + defaultName) + ";") );
	}

	bundle.body.prepend("'use strict';\n\n").trimLines();

	return packageResult( bundle, bundle.body, options, 'toCjs', true );
}

function defaultsMode_umd__umd ( bundle, options ) {
	requireName( options );

	var entry = bundle.entryModule;

	var hasImports = bundle.externalModules.length > 0;
	var hasExports = entry.exports.length > 0;

	var intro;
	if (!hasImports && !hasExports) {
		intro = standaloneUmdIntro({
			amdName: options.amdName,
		}, bundle.body.getIndentString() );
	} else {

		var defaultName = entry.identifierReplacements.default;
		if ( defaultName ) {
			bundle.body.append( (("\n\nreturn " + defaultName) + ";") );
		}

		var importPaths = bundle.externalModules.map( getId );
		var importNames = bundle.externalModules.map( getName );

		intro = defaultUmdIntro({
			hasExports: hasExports,
			importPaths: importPaths,
			importNames: importNames,
			amdName: options.amdName,
			name: options.name
		}, bundle.body.getIndentString() );
	}

	bundle.body.indent().prepend( intro ).trimLines().append('\n\n}));');

	return packageResult( bundle, bundle.body, options, 'toUmd', true );
}

var builders_defaultsMode = {
	amd: defaultsMode_amd__amd,
	cjs: defaultsMode_cjs__cjs,
	umd: defaultsMode_umd__umd
};

function getExportBlock ( entry ) {
	var name = entry.identifierReplacements.default;
	return (("exports['default'] = " + name) + ";");
}

var builders_strictMode_amd__introTemplate = template( 'define(<%= amdName %><%= amdDeps %>function (<%= names %>) {\n\n\t\'use strict\';\n\n' );

function builders_strictMode_amd__amd ( bundle, options ) {
	var externalDefaults = bundle.externalModules.filter( builders_strictMode_amd__needsDefault );
	var entry = bundle.entryModule;

	var importIds = bundle.externalModules.map( getId );
	var importNames = bundle.externalModules.map( getName );

	if ( externalDefaults.length ) {
		var defaultsBlock = externalDefaults.map( function(x ) {
			// Case 1: default is used, and named is not
			if ( !x.needsNamed ) {
				return (("" + (x.name)) + (" = ('default' in " + (x.name)) + (" ? " + (x.name)) + ("['default'] : " + (x.name)) + ");");
			}

			// Case 2: both default and named are used
			return (("var " + (x.name)) + ("__default = ('default' in " + (x.name)) + (" ? " + (x.name)) + ("['default'] : " + (x.name)) + ");");
		}).join( '\n' );

		bundle.body.prepend( defaultsBlock + '\n\n' );
	}

	if ( entry.exports.length ) {
		importIds.unshift( 'exports' );
		importNames.unshift( 'exports' );

		if ( entry.defaultExport ) {
			bundle.body.append( '\n\n' + getExportBlock( entry ) );
		}
	}

	var intro = builders_strictMode_amd__introTemplate({
		amdName: options.amdName ? (("" + (quote(options.amdName))) + ", ") : '',
		amdDeps: importIds.length ? '[' + importIds.map( quote ).join( ', ' ) + '], ' : '',
		names: importNames.join( ', ' )
	}).replace( /\t/g, bundle.body.getIndentString() );

	bundle.body.indent().prepend( intro ).trimLines().append( '\n\n});' );
	return packageResult( bundle, bundle.body, options, 'toAmd', true );
}

function builders_strictMode_amd__needsDefault ( externalModule ) {
	return externalModule.needsDefault;
}

function builders_strictMode_cjs__cjs ( bundle, options ) {
	var entry = bundle.entryModule;

	var importBlock = bundle.externalModules.map( function(x ) {
		var statement = (("var " + (x.name)) + (" = " + (req(x.id))) + ";");

		if ( x.needsDefault ) {
			statement += '\n' +
				( x.needsNamed ? (("var " + (x.name)) + "__default") : x.name ) +
				((" = ('default' in " + (x.name)) + (" ? " + (x.name)) + ("['default'] : " + (x.name)) + ");");
		}

		return statement;
	}).join( '\n' );

	if ( importBlock ) {
		bundle.body.prepend( importBlock + '\n\n' );
	}

	if ( entry.defaultExport ) {
		bundle.body.append( '\n\n' + getExportBlock( entry ) );
	}

	bundle.body.prepend("'use strict';\n\n").trimLines();

	return packageResult( bundle, bundle.body, options, 'toCjs', true );
}

function builders_strictMode_umd__umd ( bundle, options ) {
	requireName( options );

	var entry = bundle.entryModule;

	var hasImports = bundle.externalModules.length > 0;
	var hasExports = entry.exports.length > 0;

	var intro;
	if (!hasImports && !hasExports) {
		intro = standaloneUmdIntro({
			amdName: options.amdName,
		}, bundle.body.getIndentString() );
	} else {

		if ( hasExports && entry.defaultExport ) {
			bundle.body.append( '\n\n' + getExportBlock( entry ) );
		}

		var importPaths = bundle.externalModules.map( getId );
		var importNames = bundle.externalModules.map( getName );

		intro = strictUmdIntro({
			hasExports: hasExports,
			importPaths: importPaths,
			importNames: importNames,
			externalDefaults: bundle.externalModules.filter( builders_strictMode_umd__needsDefault ),
			amdName: options.amdName,
			name: options.name,
		}, bundle.body.getIndentString() );
	}

	bundle.body.indent().prepend( intro ).trimLines().append('\n\n}));');

	return packageResult( bundle, bundle.body, options, 'toUmd', true );
}

function builders_strictMode_umd__needsDefault ( externalModule ) {
	return externalModule.needsDefault;
}

var builders_strictMode = {
	amd: builders_strictMode_amd__amd,
	cjs: builders_strictMode_cjs__cjs,
	umd: builders_strictMode_umd__umd
};

// TODO rewrite with named imports/exports
var bundleBuilders = {
	defaultsMode: builders_defaultsMode,
	strictMode: builders_strictMode
};

function concat ( bundle, options ) {
	var intro, outro, indent;

	// This bundle must be self-contained - no imports or exports
	if ( bundle.externalModules.length || bundle.entryModule.exports.length ) {
		throw new Error( (("bundle.concat() can only be used with bundles that have no imports/exports (imports: [" + (bundle.externalModules.map(function(x){return x.id}).join(', '))) + ("], exports: [" + (bundle.entryModule.exports.join(', '))) + "])") );
	}

	// TODO test these options
	intro = 'intro' in options ? options.intro : ("(function () { 'use strict';\n\n");
	outro = 'outro' in options ? options.outro : '\n\n})();';

	if ( !( 'indent' in options ) || options.indent === true ) {
		indent = bundle.body.getIndentString();
	} else {
		indent = options.indent || '';
	}

	bundle.body.trimLines().indent( indent ).prepend( intro ).append( outro );

	return packageResult( bundle, bundle.body, options, 'toString', true );
}

var deprecateMessage = 'options.defaultOnly has been deprecated, and is now standard behaviour. To use named imports/exports, pass `strict: true`.',
	alreadyWarned = false;

function transpileMethod ( format ) {
	return function ( source ) {var options = arguments[1];if(options === void 0)options = {};
		var mod,
			body,
			builder;

		mod = getStandaloneModule({ source: source, getModuleName: options.getModuleName, strict: options.strict });

		if ( 'defaultOnly' in options && !alreadyWarned ) {
			// TODO link to a wiki page explaining this, or something
			console.log( deprecateMessage );
			alreadyWarned = true;
		}

		if ( options.absolutePaths && !options.amdName ) {
			throw new Error( 'You must specify an `amdName` in order to use the `absolutePaths` option' );
		}

		if ( !options.strict ) {
			// ensure there are no named imports/exports. TODO link to a wiki page...
			if ( hasNamedImports( mod ) || hasNamedExports( mod ) ) {
				throw new Error( 'You must be in strict mode (pass `strict: true`) to use named imports or exports' );
			}

			builder = moduleBuilders.defaultsMode[ format ];
		} else {
			builder = moduleBuilders.strictMode[ format ];
		}

		return builder( mod, options );
	};
}

var esperanto = {
	toAmd: transpileMethod( 'amd' ),
	toCjs: transpileMethod( 'cjs' ),
	toUmd: transpileMethod( 'umd' ),

	bundle: function ( options ) {
		return getBundle( options ).then( function ( bundle ) {
			return {
				imports: bundle.externalModules.map( function(mod ) {return mod.id} ),
				exports: flattenExports( bundle.entryModule.exports ),

				toAmd: function(options ) {return transpile( 'amd', options )},
				toCjs: function(options ) {return transpile( 'cjs', options )},
				toUmd: function(options ) {return transpile( 'umd', options )},

				concat: function(options ) {return concat( bundle, options || {} )}
			};

			function transpile ( format, options ) {
				var builder;

				options = options || {};

				if ( 'defaultOnly' in options && !alreadyWarned ) {
					// TODO link to a wiki page explaining this, or something
					console.log( deprecateMessage );
					alreadyWarned = true;
				}

				if ( !options.strict ) {
					// ensure there are no named imports/exports
					if ( hasNamedExports( bundle.entryModule ) ) {
						throw new Error( 'Entry module can only have named exports in strict mode (pass `strict: true`)' );
					}

					bundle.modules.forEach( function(mod ) {
						mod.imports.forEach( function(x ) {
							if ( hasOwnProp.call( bundle.externalModuleLookup, x.id ) && ( !x.isDefault && !x.isBatch ) ) {
								throw new Error( 'You can only have named external imports in strict mode (pass `strict: true`)' );
							}
						});
					});

					builder = bundleBuilders.defaultsMode[ format ];
				} else {
					builder = bundleBuilders.strictMode[ format ];
				}

				return builder( bundle, options );
			}
		});
	}
};

function flattenExports ( exports ) {
	var flattened = [];

	exports.forEach( function(x ) {
		if ( x.isDefault ) {
			flattened.push( 'default' );
		}

		else if ( x.name ) {
			flattened.push( x.name );
		}

		else if ( x.specifiers ) {
			flattened.push.apply( flattened, x.specifiers.map( getName ) );
		}
	});

	return flattened;
}

module.exports = esperanto;