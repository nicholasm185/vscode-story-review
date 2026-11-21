package shop

// Item is one line in a cart.
type Item struct {
	Name  string
	Price int
	Qty   int
}

// Total adds up the cart.
func Total(items []Item) int {
	sum := 0
	for _, it := range items {
		sum += it.Price * it.Qty
	}
	return sum
}
