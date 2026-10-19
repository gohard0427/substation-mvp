import assert from 'node:assert/strict';import {formatStationName} from '../shared/free-model.mjs';
for(const [input,expected] of [['연수','연수S/S'],['연수S/S','연수S/S'],['연수 s/s','연수S/S'],['연수 변전소','연수S/S'],['연수 변전소 S/S','연수S/S'],['연수S/SS/S','연수S/S'],['연수S/S GIS실','연수S/S GIS실'],['','']])assert.equal(formatStationName(input),expected);
console.log('PASS station name formatting and duplicate suffix prevention');
