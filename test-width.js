// Test what actual width we need
const termWidth = 80;
const charWidth = 9;
const requiredPixels = termWidth * charWidth;
console.log('80 columns at 9px/char = ', requiredPixels, 'px');
console.log('iPhone 14 Pro Max width = 430px');
console.log('Scale factor needed:', 430 / requiredPixels);
console.log('Font size at that scale:', 16 * (430 / requiredPixels), 'px');

// What if we use actual rendered char width?
const actualCharWidth = 9.6; // Courier New is slightly wider
const actualRequired = termWidth * actualCharWidth;
console.log('\nWith 9.6px/char:');
console.log('80 columns = ', actualRequired, 'px');
console.log('Font size needed:', 16 * (430 / actualRequired), 'px');
