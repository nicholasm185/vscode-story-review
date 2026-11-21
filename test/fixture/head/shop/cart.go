package shop

// Item is one line in a cart.
type Item struct {
	Name  string
	Price int
	Qty   int
}

// Total adds up the cart and takes off the best discount code.
func Total(items []Item, codes []string) int {
	sum := subtotal(items)
	off := bestDiscount(sum, codes)
	if off > sum {
		off = sum
	}
	return sum - off
}

// subtotal is the cart before any discount.
func subtotal(items []Item) int {
	sum := 0
	for _, it := range items {
		sum += it.Price * it.Qty
	}
	return sum
}
