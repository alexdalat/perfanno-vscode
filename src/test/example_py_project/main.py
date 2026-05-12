# original example from https://github.com/MalTeeez/python-perfanno-example/blob/main/src/main.py
# profile output use:  
#   uv run py-spy record --full-filenames --idle --native --rate 198 --format raw -o pyspy.txt -- python main.py

import math
import time
import functools
import requests

def timeit_ms(func):
    @functools.wraps(func)
    def wrapper(*args, **kwargs):
        start = time.time()
        try:
            return func(*args, **kwargs)
        finally:
            elapsed_ms = (time.time() - start) * 1000
            print(f"Time taken for {func.__name__}: {elapsed_ms:.3f} ms")
    return wrapper


def main():
    result = light_operation(2)
    print(f"\tResult: {result}")
    # about 350 +- 150ms

    result = sleep_operation(2)
    print(f"\tResult: {result}")
    # about 500 +- 5ms

    result = network_operation()
    print(f"\tStatus code: {result}")
    # any time under 5s is good


@timeit_ms
def light_operation(x):
    size = 10**6
    arr = [None] * size
    arr = [math.sin(i + x) for i in range(size)]
    return sum(arr)


@timeit_ms
def sleep_operation(x):
    time.sleep(0.5)
    return 1


@timeit_ms
def network_operation():
    headers = {"Cache-Control": "no-cache", "Pragma": "no-cache"}
    try:
        response = requests.get("https://httpbin.org/get", headers=headers, timeout=5)
        return response.status_code
    except Exception as e:
        print(f"Network operation error: {e}")
        return None


if __name__ == "__main__":
    main()
