export function nativeSortInPlace(array, compareFn) {
  if (!Array.isArray(array)) {
    throw new TypeError("nativeSortInPlace expects an array input.");
  }

  array.sort(compareFn);
  return array;
}

export const NATIVE_SORTER = Object.freeze({
  id: "native",
  label: "Array.prototype.sort",
  sortInPlace: nativeSortInPlace
});

export default nativeSortInPlace;
