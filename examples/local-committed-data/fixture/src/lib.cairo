#[starknet::contract]
mod ReplayOracle {
    use core::array::ArrayTrait;
    use core::traits::TryInto;
    use starknet::{ContractAddress, get_caller_address, syscalls};
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};

    #[storage]
    struct Storage {
        admin: ContractAddress,
        legacy_price: felt252,
        root: felt252,
        committed_enabled: bool,
        last_settlement: felt252,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        Settled: Settled,
    }

    #[derive(Drop, starknet::Event)]
    struct Settled {
        price: felt252,
        result: felt252,
        committed: felt252,
    }

    #[constructor]
    fn constructor(ref self: ContractState, admin: ContractAddress) {
        self.admin.write(admin);
    }

    fn only_admin(self: @ContractState) {
        assert(get_caller_address() == self.admin.read(), 'admin only');
    }

    #[external(v0)]
    fn set_legacy_price(ref self: ContractState, price: felt252) {
        only_admin(@self);
        self.legacy_price.write(price);
    }

    #[external(v0)]
    fn set_root(ref self: ContractState, root: felt252) {
        only_admin(@self);
        self.root.write(root);
    }

    // C2-only fixture toggle, sent by its separate local admin account.
    #[external(v0)]
    fn enable_committed(ref self: ContractState) {
        self.committed_enabled.write(true);
    }

    #[external(v0)]
    fn settle(ref self: ContractState, a: felt252, b: felt252) {
        only_admin(@self);
        let root = self.root.read();
        let (price, committed) = if self.committed_enabled.read() {
            let values = syscalls::call_contract_syscall(
                selector!("committed_data_v1").try_into().unwrap(),
                selector!("get_value"),
                array![root, 0].span(),
            ).unwrap();
            assert(values.len() == 1, 'read length');
            (*values.at(0), 1)
        } else {
            (self.legacy_price.read(), 0)
        };
        let result = a + b + price;
        self.last_settlement.write(result);
        self.emit(Event::Settled(Settled { price, result, committed }));
    }

    #[external(v0)]
    fn get_state(self: @ContractState) -> (felt252, felt252, felt252) {
        (self.legacy_price.read(), self.root.read(), self.last_settlement.read())
    }
}
