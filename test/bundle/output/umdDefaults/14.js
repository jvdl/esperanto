(function (global, factory) {
	typeof exports === 'object' && typeof module !== 'undefined' ? factory(require('external')) :
	typeof define === 'function' && define.amd ? define(['external'], factory) :
	factory(global.foo)
}(this, function (foo__default) { 'use strict';

	foo__default();

}));