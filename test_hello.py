import unittest

from hello import greet


class GreetTests(unittest.TestCase):
    def test_default(self):
        self.assertEqual(greet(), "Hello, world!")

    def test_name(self):
        self.assertEqual(greet("Claude"), "Hello, Claude!")


if __name__ == "__main__":
    unittest.main()
