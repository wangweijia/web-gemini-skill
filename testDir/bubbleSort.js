/**
 * 冒泡排序算法
 * @param {number[]} arr - 待排序的数组
 * @returns {number[]} 排序后的数组
 */
function bubbleSort(arr) {
    const len = arr.length;
    for (let i = 0; i < len - 1; i++) {
        // 优化：设置标志位，若某轮没有发生交换则说明已完成排序
        let swapped = false;
        for (let j = 0; j < len - 1 - i; j++) {
            if (arr[j] > arr[j + 1]) {
                // 交换元素
                const temp = arr[j];
                arr[j] = arr[j + 1];
                arr[j + 1] = temp;
                swapped = true;
            }
        }
        if (!swapped) break;
    }
    return arr;
}

