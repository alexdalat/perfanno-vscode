
// compiled with:  g++ -std=c++17 -Wall -fno-omit-frame-pointer -g -O2 main.cpp
// profiled with:  perf record --call-graph dwarf -- ./a.out
// analyzed with:  perf report -g folded,0,caller,srcline,branch,count --no-children --full-source-path --stdio -i perf.data > perf.out

// output
#include <iostream>

// time related
#include <chrono>
#include <thread>

// network related
#include <sys/socket.h>
#include <netdb.h>
#include <unistd.h>

// other
#include <vector>
#include <cstring> // strlen
#include <functional>


// Helper function to perform a simple network request to example.com
void simple_network_request() {
  int sock = socket(AF_INET, SOCK_STREAM, 0);
  struct hostent* host = gethostbyname("example.com");
  struct sockaddr_in addr{};
  addr.sin_family = AF_INET;
  addr.sin_port = htons(80);
  addr.sin_addr = *((struct in_addr*)host->h_addr);
  connect(sock, (struct sockaddr*)&addr, sizeof(addr));

  const char* req = "GET / HTTP/1.0\r\nHost: example.com\r\n\r\n";
  send(sock, req, strlen(req), 0);

  char buf[4096] = {};
  recv(sock, buf, sizeof(buf), 0);
  close(sock);
}


// Section: For loop
void for_loop_section() {
  const unsigned int N = 1000000;
  std::vector<int> vec(N);
  for (unsigned int i = 0; i < N; ++i) {
    vec[i] = i;
  }
  vec.clear();
  // about 150ms +- 20ms
}


// Section: Sleep
void sleep_section() {
  std::this_thread::sleep_for(std::chrono::milliseconds(200));
  // about 200ms +- 10ms
}


// Section: Threading
void threading_section() {
  auto start = std::chrono::high_resolution_clock::now();
  
  std::thread t([start]() {
    std::this_thread::sleep_for(std::chrono::milliseconds(200));
    auto end = std::chrono::high_resolution_clock::now();
    auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(end - start)
             .count();
    std::cout << "(thread) Time taken for sleep: " << ms << " ms" << std::endl;
  });

  auto end = std::chrono::high_resolution_clock::now();
  auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(end - start)
           .count();
  std::cout << "(main) Time taken for threaded sleep: " << ms << " ms" << std::endl;
  // 0ms
  
  t.join();
  // about 200ms +- 10ms
}


// Section: Network request
void network_section() {
  simple_network_request();
}


// Timer wrapper for functions
void time_function(const std::string& description, std::function<void()> func) {
  auto start = std::chrono::high_resolution_clock::now();
  func();
  auto end = std::chrono::high_resolution_clock::now();
  auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(end - start)
                .count();
  std::cout << "Time taken for " << description << ": " << ms << " ms" << std::endl;
}


int main() {
  time_function("for loop", for_loop_section);
  time_function("sleep", sleep_section);
  time_function("threaded sleep", threading_section);

  // network request - warm up DNS cache first
  simple_network_request();
  time_function("network request", network_section);

  return 0;
}
